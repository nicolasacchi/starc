# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 2 — building construction.
      #
      # A building accepted by the `build` command exists from that moment
      # with `build_progress` at 0 and its supply already reserved; it simply
      # is not finished. `built` fires at exactly 100%.
      module Construction
        def self.step(world, dt)
          completed = false
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive? && e.is_building
            next if e.complete?

            e.build_progress += dt / e.build_time
            next if e.build_progress < 1.0

            e.build_progress = 1.0
            e.hp = e.hp_max
            e.state = "idle"
            completed = true
            world.emit(
              "e" => "built", "id" => e.id, "ty" => e.type_key,
              "x" => round3(e.x), "y" => round3(e.z), "z" => round3(e.z_world)
            )
          end
          return unless completed

          # The worker that placed it is free again.
          j = 0
          while j < world.living.size
            w = world.living[j]
            j += 1
            next unless w.construct_id.positive?

            b = world.entity(w.construct_id)
            next if b && b.alive?

            w.construct_id = 0
            w.state = "idle" if w.state == "building"
          end
        end

        def self.round3(v)
          (v * 1000.0).round / 1000.0
        end
      end
    end
  end
end
