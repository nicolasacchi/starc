# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 11 — victory check.
      #
      #   annihilation — one player is left standing
      #   timeout      — 90 minutes of sim time, highest `army_value` wins
      #   stalemate    — a timeout tie, or everyone wiped out
      #   forfeit      — set by `World#forfeit`, not by this phase
      #
      # Once a result exists, `World#step!` is a no-op, so the final state
      # stays exactly as the tick that produced it.
      module Victory
        def self.step(world, dt)
          return if world.finished?

          if world.timeout?
            finish_on_timeout(world)
            return
          end

          # A one-sided match is a warm-up or a test fixture, not a win.
          return if world.player_ids.size < 2

          standing = world.player_ids.select { |pid| world.state(pid)[:alive] }
          return if standing.size > 1
          if standing.empty?
            world.finish!(nil, Starc::Sim::World::STALEMATE_REASON)
          else
            world.finish!(standing.first, Starc::Sim::World::ANNIHILATION_REASON)
          end
        end

        def self.finish_on_timeout(world)
          best = nil
          best_value = nil
          tie = false
          world.player_ids.each do |pid|
            st = world.state(pid)
            value = st ? st[:army_value] : 0
            if best_value.nil? || value > best_value
              best = pid
              best_value = value
              tie = false
            elsif value == best_value
              tie = true
            end
          end
          if tie
            world.finish!(nil, Starc::Sim::World::STALEMATE_REASON)
          else
            world.finish!(best, Starc::Sim::World::TIMEOUT_REASON)
          end
        end
      end

    end
  end
end
