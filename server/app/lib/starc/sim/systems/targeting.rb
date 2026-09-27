# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 6 — target acquisition.
      #
      # Nobody scans the entity table. Every acquisition is a `SpatialIndex`
      # radius query bounded by the shooter's own weapon range, so the cost is
      # proportional to how crowded the fight is, not to how big the match has
      # become. A weapon may only acquire the classes in its `targets` list, so
      # a ground-only cannon never latches onto a flying carrier.
      module Targeting
        ORDER_NONE = Starc::Sim::Entity::ORDER_NONE
        ORDER_ATTACK = Starc::Sim::Entity::ORDER_ATTACK
        ORDER_HARVEST = Starc::Sim::Entity::ORDER_HARVEST

        def self.step(world, dt)
          tick = world.tick
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive?

            drop_dead_target(world, e)
            # A worker on a mining run keeps mining; a building that is still
            # going up does not open fire.
            next if e.order == ORDER_HARVEST
            next if e.is_building && !e.complete?

            weapon = world.weapon_for(e)
            next if weapon.nil?

            if e.target_id.positive?
              t = world.entity(e.target_id)
              next if t && t.alive? && world.can_hit?(weapon, t)

              e.target_id = 0
              next
            end
            # `hold` means "stand still and shoot what is already there".
            next if e.hold_position && e.order == ORDER_NONE

            found = world.find_nearest_enemy(e, weapon["range"], tick: tick)
            next if found.nil? || !world.can_hit?(weapon, found)

            e.target_id = found.id
            e.order = ORDER_ATTACK if e.order == ORDER_NONE
          end
        end

        # Clear a target that died, became an ally, or vanished.
        def self.drop_dead_target(world, e)
          return unless e.target_id.positive?

          t = world.entity(e.target_id)
          return if t && t.alive? && world.enemies?(t.player_id, e.player_id)

          e.target_id = 0
          return unless e.order == ORDER_ATTACK

          e.order = ORDER_NONE
          e.state = "idle" if e.unit?
        end
      end
    end
  end
end
