# frozen_string_literal: true

module Starc
  # Accumulates the accepted command stream of a live match and writes the
  # replay described in PROTOCOL.md §8 when it ends.
  #
  # A replay is deterministic: feeding `commands` into the shared simulation
  # from `header.seed` has to reproduce `final_state`. So a command is recorded
  # only once the world has *accepted* it, and it is stamped with the tick it
  # was applied on plus its index in the batch it arrived in — the two pieces of
  # information the format carries alongside the command itself.
  class ReplayWriter
    def initialize(match)
      @match = match
      @mutex = Mutex.new
      @commands = []
    end

    attr_reader :match

    # `command` is the wire hash exactly as the client sent it.
    def record(tick:, player_id:, index:, command:)
      entry = { "tick" => tick.to_i, "player_id" => player_id.to_i, "index" => index.to_i }
      command.each { |key, value| entry[key.to_s] = value }
      @mutex.synchronize { @commands << entry }
      entry
    end

    def commands
      @mutex.synchronize { @commands.dup }
    end

    def command_count
      @mutex.synchronize { @commands.size }
    end

    # PROTOCOL.md §8. `replays.match_id` is unique, so a second call cannot
    # insert a duplicate row: the write is rejected and the first replay — the
    # one the running match produced — is kept and returned.
    def finalize!(winner:, duration_ms:, tick_count:, final_state:)
      reload_match
      Replay.record!(
        match: @match,
        commands: commands,
        final_state: final_state,
        tick_count: tick_count.to_i,
        header: header_for(winner: winner, duration_ms: duration_ms),
        command_count: command_count
      )
    rescue ActiveRecord::RecordInvalid, ActiveRecord::RecordNotUnique => e
      Rails.logger.warn("[starc] replay for match #{@match.id} already written: #{e.class}")
      Replay.find_by(match_id: @match.id)
    end

    private

    # The end-of-match path writes the results onto the match and its seats
    # first, so the header has to be read back from the database.
    def reload_match
      @match.reload
    rescue ActiveRecord::ActiveRecordError => e
      Rails.logger.warn("[starc] match #{@match.id} reload failed: #{e.class}: #{e.message}")
    end

    def header_for(winner:, duration_ms:)
      @match.replay_header.merge(winner: winner, duration_ms: duration_ms.to_i)
    end
  end
end
