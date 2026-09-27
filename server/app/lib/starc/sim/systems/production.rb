# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 3 — production queues.
      #
      # A complete building with a non-empty `produces` trains the head of its
      # queue and, once `build_time` has elapsed, spawns the unit adjacent to
      # the building. The cost was already deducted when the `train` command
      # was accepted, and the unit's supply was reserved at that moment, so
      # production never re-checks affordability mid-queue.
      module Production
        ORDER_MOVE = Starc::Sim::Entity::ORDER_MOVE

        # Units walk out of the building's door on one of eight fixed headings,
        # cycling per building. Fixed headings (rather than a random one) keep
        # replays identical without spending an RNG draw per spawn.
        EXIT_ANGLES = Array.new(8) { |i| Math::PI * 2.0 * i / 8.0 }.freeze
        EXIT_MARGIN = 0.5

        def self.step(world, dt)
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive? && e.is_building && e.complete?

            if e.train_key.nil? && !e.train_queue.empty?
              e.train_key = e.train_queue.shift
              e.train_progress = 0.0
            end
            next if e.train_key.nil?

            defn = Starc::GameData.unit(e.train_key)
            if defn.nil?
              e.train_key = nil
              e.train_progress = nil
              next
            end

            e.state = "training"
            e.train_progress += dt / build_time(defn)
            next if e.train_progress < 1.0

            e.train_progress = 0.0
            spawn_trained(world, e, e.train_key)
            release_supply(world, e.player_id, defn)
            e.train_key = e.train_queue.shift
            e.state = e.train_key.nil? ? "idle" : "training"
          end
        end

        def self.build_time(defn)
          t = (defn["build_time"] || 1).to_f
          t < 0.05 ? 0.05 : t
        end

        def self.release_supply(world, player_id, defn)
          st = world.state(player_id)
          st[:supply_pending] -= (defn["cost"] || {}).fetch("supply", 0).to_i if st
        end

        def self.spawn_trained(world, building, unit_type)
          defn = Starc::GameData.unit(unit_type)
          return nil unless defn

          size = defn["size"] || {}
          offset = building.radius + (size["radius"] || 0.5).to_f + EXIT_MARGIN
          angle = EXIT_ANGLES[building.train_serial % EXIT_ANGLES.size]
          building.train_serial += 1
          x = building.x + (Math.cos(angle) * offset)
          z = building.z + (Math.sin(angle) * offset)

          unit = world.spawn_entity(unit_type, building.player_id, x, z)
          return nil unless unit

          if building.rally_x
            unit.order = ORDER_MOVE
            unit.order_x = building.rally_x
            unit.order_z = building.rally_z
            unit.state = "moving"
          end
          world.emit(
            "e" => "built", "id" => unit.id, "ty" => unit.type_key,
            "x" => round3(unit.x), "z" => round3(unit.z), "y" => round3(unit.z_world)
          )
          unit
        end

        def self.round3(v)
          (v * 1000.0).round / 1000.0
        end
      end
    end
  end
end
