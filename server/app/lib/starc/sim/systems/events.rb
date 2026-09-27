# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 12 — event drain.
      #
      # A deliberate no-op, and here is why. Events accumulate during the tick
      # that produced them and are consumed by whoever reads them next;
      # `World#snapshot` calls `drain_events`, so the channel gets each event
      # in exactly one frame without this phase having to know the broadcast
      # cadence. Draining here instead would make events produced on odd ticks
      # survive or vanish depending on when the channel happens to look, which
      # is exactly the timing dependence the rest of the simulation avoids.
      module Events
        def self.step(_world, _dt)
          nil
        end

      end
    end
  end
end
