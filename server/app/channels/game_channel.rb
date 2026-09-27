# frozen_string_literal: true

# Gameplay channel `game:<match_id>` (PROTOCOL.md §1, §3, §4, §5).
#
# The channel is a thin, authenticated door onto the match: it owns membership
# and the wire shapes, while `Starc::MatchRunner` owns the simulation. Every
# subscriber is also a player of the match — including one that reconnects
# mid-game, which is why `game:start` is (re)sent on subscription: the client
# rebuilds the opening state from it and the following snapshot brings it
# current.
class GameChannel < ApplicationCable::Channel
  handles "identify", :identify
  handles "game:command", :game_command
  handles "game:forfeit", :game_forfeit

  def subscribed
    @match_id = params[:match_id].to_i
    @match = Match.find_by(id: @match_id)
    if @match.nil?
      refuse!("not_found", "no match #{@match_id}")
      return
    end

    # An unidentified connection is allowed to subscribe (PROTOCOL.md §1 has it
    # `identify` first) but may do nothing else until it has. The match stream
    # is joined in `enter` rather than here, so a connection only ever carries
    # a match it turned out to be a player of.
    enter(current_player) if current_player
  end

  # Driven by the connection going away. Only a seated subscriber has a
  # player to lose: a refused subscription, or one that never identified, must
  # not reach the runner, or a stranger's disconnect reads as a seat vacating
  # and the match is decided without it.
  def unsubscribed
    stop_all_streams
    player_id = @player_id
    @player_id = nil
    @seated = false
    return if player_id.nil? || refused?

    Starc::MatchRunner.for(@match_id)&.player_disconnected(player_id)
    nil
  end

  def identify(data)
    player = identify_player(data["token"].to_s)
    if player.nil?
      terminate!("unauthenticated", "that session token is not valid")
      return
    end

    enter(player)
  end

  def game_command(data)
    return unless require_player

    runner = live_runner
    return if runner.nil?

    result = runner.apply_commands(@player_id, data["commands"], data["from_tick"])
    rejected = result[:rejected]
    transmit_message("game:reject", rejected: rejected) if rejected.any?
  end

  def game_forfeit(_data)
    return unless require_player

    runner = live_runner
    return if runner.nil?

    runner.player_forfeits(@player_id)
  end

  private

  # Binds this subscription to a player of the match. Anything else is not a
  # participant and has no business on the stream.
  #
  # Membership is decided before `@player_id` is set, never after: a refused
  # subscriber that carries a player id takes that id with it when the
  # connection drops, and `unsubscribed` would tell the runner a player of
  # this match had left. `refuse!` additionally unsubscribes right here, so
  # there is no window in which this channel holds game state at all.
  def enter(player)
    return false if player.nil? || refused?

    unless @match.match_players.exists?(player_id: player.id)
      refuse!("not_found", "you are not a player in match #{@match_id}")
      return false
    end

    # `enter` runs on subscription, on `identify` and again as a recovery in
    # `require_player`. One subscription is one connection, so the runner is
    # told about it exactly once — a second seat in the count would outlive
    # the real connection and the match would never be decided.
    return true if @seated && @player_id == player.id

    @player_id = player.id
    @seated = true
    # The stream is the match's own broadcast: every snapshot, every command
    # echo, every `game:ended`. It is joined only for a player of this match,
    # so a refused or unidentified subscriber is not a silent spectator of
    # somebody else's game.
    stream_from Starc::LobbyRegistry.game_stream(@match_id)
    # The runner has to exist before the connection is counted, not after: a
    # match nobody has subscribed to yet is adopted right here, and a count
    # handed to a runner that did not exist is a count nobody keeps — the next
    # tab would be the first one the runner ever heard of, and closing it
    # would read as the player leaving.
    seated = send_game_start
    Starc::MatchRunner.for(@match_id)&.player_connected(@player_id) if seated
    seated
  end

  def require_player
    return true if @player_id

    # A client that skipped `identify` may still recover here if the connection
    # itself carried a token.
    return true if current_player && enter(current_player)

    terminate!("unauthenticated", "send identify with a session token first")
    false
  end

  def send_game_start
    return true if @start_sent

    runner = Starc::MatchRunner.for(@match_id)
    if runner.nil?
      # A live match with no runner here is one this process has not adopted
      # yet — a match started over the REST API gets its runner on the first
      # subscription. A match that is still in its lobby says nothing at all.
      return true unless @match.in_progress?

      runner = Starc::MatchRunner.adopt(@match)
    end

    if runner.nil?
      terminate!("server_error", "match #{@match_id} could not be started on this server")
      return false
    end

    @start_sent = true
    transmit runner.start_payload.to_json
    true
  end

  def live_runner
    runner = Starc::MatchRunner.for(@match_id)
    terminate!("not_found", "match #{@match_id} is not running") if runner.nil?
    runner
  end
end
