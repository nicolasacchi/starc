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
      terminate!("not_found", "no match #{@match_id}")
      return
    end

    stream_from Starc::LobbyRegistry.game_stream(@match_id)

    # An unidentified connection is allowed to subscribe (PROTOCOL.md §1 has it
    # `identify` first) but may do nothing else until it has.
    enter(current_player) if current_player
  end

  def unsubscribed
    stop_all_streams
    return if @player_id.nil?

    Starc::MatchRunner.for(@match_id)&.player_disconnected(@player_id)
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
  def enter(player)
    return false if player.nil?

    @player_id = player.id
    if @match.match_players.find_by(player_id: @player_id).nil?
      terminate!("not_found", "you are not a player in match #{@match_id}")
      return false
    end

    Starc::MatchRunner.for(@match_id)&.player_connected(@player_id)
    send_game_start
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
