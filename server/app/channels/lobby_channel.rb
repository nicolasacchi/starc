# frozen_string_literal: true

# Lobby channel `lobby` (PROTOCOL.md §2): the match browser and the room in
# front of a match.
#
# `lobby:list` is open — the browser is public — while every mutating action
# needs a player. Any state change is announced twice: once on the shared
# `lobby` stream for everybody, and once on the player's own stream for the
# `you` block, which is per-player by definition. The database is the source of
# truth; `Starc::LobbyRegistry` is the fan-out cache in front of it.
class LobbyChannel < ApplicationCable::Channel
  CHAT_MIN_LENGTH = 1
  CHAT_MAX_LENGTH = 280
  CHAT_RATE_LIMIT = 0.5
  CHAT_BUFFER = 100
  MIN_PLAYERS = 2
  MAX_PLAYERS = 8

  handles "identify", :identify
  handles "lobby:list", :lobby_list
  handles "lobby:create", :lobby_create
  handles "lobby:join", :lobby_join
  handles "lobby:leave", :lobby_leave
  handles "lobby:ready", :lobby_ready
  handles "lobby:settings", :lobby_settings
  handles "lobby:start", :lobby_start
  handles "lobby:chat", :lobby_chat

  def subscribed
    stream_from Starc::LobbyRegistry::LOBBY_STREAM
    subscribe_personal
    sync_chat_stream
    send_state
  end

  def unsubscribed
    # Losing the lobby tab while still in its lobby means leaving it: a match
    # must not sit in the browser waiting for somebody who has gone. A match
    # already under way is not touched — `GameChannel` owns disconnect handling
    # from there, and its forfeit countdown would be wrong to start twice.
    return if @player_id.nil?

    match = lobby_match_of(@player_id)
    return if match.nil?

    match.remove_player!(@player_id)
    match.update!(status: :abandoned, ended_at: Time.current) if match.player_count.zero?
    Starc::LobbyRegistry.instance.unregister(match.id)
    Starc::LobbyRegistry.instance.broadcast_state
  rescue StandardError => e
    Rails.logger.warn("[starc] lobby leave on disconnect failed: #{e.class}: #{e.message}")
  end

  def identify(data)
    player = identify_player(data["token"].to_s)
    if player.nil?
      terminate!("unauthenticated", "that session token is not valid")
      return
    end

    subscribe_personal
    sync_chat_stream
    send_state
  end

  def lobby_list(data)
    registry = Starc::LobbyRegistry.instance
    transmit_message("lobby:state", matches: registry.matches(data["filters"]), you: registry.context_for(player_id))
  end

  def lobby_create(data)
    return unless require_player

    name = data["name"].to_s.strip
    mode = data["mode"].to_s
    map_id = data["map_id"].to_s
    return reject_payload("name must be 1..64 characters") if name.empty? || name.length > 64
    return reject_payload("mode must be one of #{Match::MODES.join(', ')}") unless Match::MODES.include?(mode)

    map = Starc::Maps.find(map_id)
    return reject_payload("unknown map #{map_id.inspect}") if map.nil?

    max_players = clamp_max_players(data["max_players"], map)
    match = Match.create!(
      name: name,
      mode: mode,
      map_id: map_id,
      max_players: max_players,
      seed: SecureRandom.random_number(2**32),
      status: :lobby
    )
    set_password(match, data["password"])
    match.save!
    match.add_player!(player: current_player, race: playable_race(data["race_preference"]), host: true)
    Starc::LobbyRegistry.instance.register(match.id)
    announce_state
  rescue ActiveRecord::RecordInvalid => e
    reject_payload(e.record&.errors&.full_messages&.to_sentence.to_s)
  end

  def lobby_join(data)
    return unless require_player

    match = Match.find_by(id: data["match_id"].to_i)
    return reject_message("not_found", "no such match") if match.nil?
    return reject_message("match_in_progress", "that match has already started") unless match.lobby?
    return reject_message("already_in_match", "you are already in that match") if match.match_players.exists?(player_id: player_id)
    return reject_message("lobby_full", "that match is full") if match.full?
    return reject_message("wrong_password", "incorrect match password") unless password_ok?(match, data["password"])

    match.add_player!(player: current_player, race: playable_race(data["race_preference"]), host: false)
    Starc::LobbyRegistry.instance.register(match.id)
    announce_state
  rescue ActiveRecord::RecordInvalid => e
    reject_message("lobby_full", e.record&.errors&.full_messages&.to_sentence.to_s)
  end

  def lobby_leave(data)
    return unless require_player

    match = lobby_match_of(player_id, id: data["match_id"])
    return reject_message("match_in_progress", "a running match cannot be left") if match&.in_progress?
    return reject_message("not_found", "you are not in that match") if match.nil?

    match.remove_player!(current_player)
    if match.player_count.zero?
      match.update!(status: :abandoned, ended_at: Time.current)
      Starc::LobbyRegistry.instance.unregister(match.id)
    end
    announce_state
  end

  def lobby_ready(data)
    return unless require_player

    match = lobby_match_of(player_id, id: data["match_id"])
    return reject_message("not_found", "you are not in that match") if match.nil?

    match.match_players.find_by(player_id: player_id).update!(ready: data["ready"] ? true : false)
    announce_state
  end

  def lobby_settings(data)
    return unless require_player

    match = Match.find_by(id: data["match_id"].to_i)
    return reject_message("not_found", "no such match") if match.nil?
    return reject_message("not_host", "only the host can change the settings") unless host?(match)
    return reject_message("match_in_progress", "a running match cannot be changed") unless match.lobby?

    apply_settings(match, data)
    match.save!
    announce_state
  rescue ActiveRecord::RecordInvalid => e
    reject_payload(e.record&.errors&.full_messages&.to_sentence.to_s)
  end

  def lobby_start(data)
    return unless require_player

    match = Match.find_by(id: data["match_id"].to_i)
    return reject_message("not_found", "no such match") if match.nil?
    return reject_message("match_in_progress", "that match has already started") unless match.lobby?
    return reject_message("not_host", "only the host can start the match") unless host?(match)
    return reject_message("not_ready", "every player has to be ready first") unless match.all_ready?

    match.start!
    # The runner is what makes the match live: it builds the world and starts
    # stepping. Subscribers of `game:<id>` get `game:start` from it.
    if Starc::MatchRunner.adopt(match).nil?
      match.update!(status: :abandoned, ended_at: Time.current)
      return reject_message("server_error", "the match could not be started on this server")
    end

    announce_state
  end

  def lobby_chat(data)
    return unless require_player

    match_id = data["match_id"].to_i
    seat = MatchPlayer.find_by(match_id: match_id, player_id: player_id)
    return reject_message("not_found", "you are not in that match") if seat.nil?

    text = data["text"].to_s
    if text.length < CHAT_MIN_LENGTH || text.length > CHAT_MAX_LENGTH
      return reject_payload("chat must be #{CHAT_MIN_LENGTH}..#{CHAT_MAX_LENGTH} characters")
    end
    if (now = monotonic) - @last_chat_at < CHAT_RATE_LIMIT
      return reject_message("rate_limited", "you are sending chat too fast")
    end

    @last_chat_at = now
    line = {
      "player_id" => player_id,
      "name" => current_player.name,
      "text" => text,
      "ts" => self.class.now_ms
    }
    Starc::LobbyRegistry.instance.push_chat(match_id, line)
    transmit_message("lobby:chat", match_id: match_id, lines: [line])
  end

  private

  def registry
    Starc::LobbyRegistry.instance
  end

  # Every state change: the browser for everybody, then the `you` block for
  # this player on every tab they have open.
  def announce_state
    registry.invalidate!
    registry.broadcast_state
    registry.publish_context(player_id)
    sync_chat_stream
  end

  def send_state
    transmit_message("lobby:state", matches: registry.matches, you: registry.context_for(player_id))
  end

  def subscribe_personal
    return if @player_id.nil? || @personal_stream

    @personal_stream = registry.class.player_stream(@player_id)
    stream_from @personal_stream
  end

  # Chat is per match, so a connection only listens to the room it is in — and
  # is caught up on the last CHAT_BUFFER lines when it arrives.
  def sync_chat_stream
    context = registry.context_for(player_id)
    match_id = context && context["match_id"]
    return if match_id == @chat_match_id

    stop_stream(registry.class.match_chat_stream(@chat_match_id)) if @chat_match_id
    @chat_match_id = match_id
    return if match_id.nil?

    stream = registry.class.match_chat_stream(match_id)
    stream_from stream
    history = registry.chat_history(match_id)
    transmit_message("lobby:chat", match_id: match_id, lines: history) if history.any?
  end

  def require_player
    return true if player_id

    terminate!("unauthenticated", "sign in before joining a match")
    false
  end

  def reject_message(code, message)
    transmit_error(code, message)
    nil
  end

  def reject_payload(message)
    reject_message("invalid_payload", message)
  end

  def lobby_match_of(player, id: nil)
    matches = Match.where(id: [id, current_match_id(player)].compact).to_a
    matches.find { |m| m.match_players.exists?(player_id: player) && !m.finished? && !m.abandoned? }
  end

  def current_match_id(player)
    MatchPlayer.where(player_id: player).order(:slot).first&.match_id
  end

  def host?(match)
    match.match_players.find_by(player_id: player_id)&.host?
  end

  def apply_settings(match, data)
    name = data["name"].to_s.strip
    match.name = name if name.present?
    match.mode = data["mode"].to_s if Match::MODES.include?(data["mode"].to_s)

    if (map_id = data["map_id"].to_s).present?
      map = Starc::Maps.find(map_id)
      raise ActiveRecord::RecordInvalid, match if map.nil?
      raise ActiveRecord::RecordInvalid, match if map["max_players"].to_i < match.player_count

      match.map_id = map_id
      match.max_players = [clamp_max_players(data["max_players"], map), match.player_count].max
    elsif data.key?("max_players")
      match.max_players = clamp_max_players(data["max_players"], nil)
    end

    set_password(match, data["password"]) if data["password"].present?
  end

  def set_password(match, password)
    return if password.blank?

    match.password_digest = BCrypt::Password.create(password.to_s)
  end

  def password_ok?(match, password)
    return true if match.password_digest.blank?
    return false if password.blank?

    match.authenticate(password.to_s)
  rescue BCrypt::Errors::InvalidHash, BCrypt::Errors::InvalidPassword
    false
  end

  def playable_race(preference)
    race = preference.to_s
    MatchPlayer::RACES.include?(race) && !match_race_taken?(race) ? race : nil
  end

  def match_race_taken?(_race)
    false
  end

  def clamp_max_players(requested, map)
    value = requested.is_a?(Integer) ? requested : (Integer(requested.to_s, exception: false) || MIN_PLAYERS)
    value = MIN_PLAYERS if value < MIN_PLAYERS
    value = MAX_PLAYERS if value > MAX_PLAYERS
    cap = map && map["max_players"].to_i
    value = cap if cap.positive? && value > cap
    value
  end

  def monotonic
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end
end
