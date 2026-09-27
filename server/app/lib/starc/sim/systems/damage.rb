# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 9 — damage resolution and deaths.
      #
      # Shield absorption, armour and the minimum-one-damage floor all happen
      # in `World#apply_damage`, which every source funnels through: bullets,
      # beams, melee, splash, and abilities. This phase does the two things
      # that must happen after every source has landed — shield regeneration
      # for units that have been out of combat, and the bookkeeping for
      # everything that has died.
      module Damage
        # A unit's shield only starts recharging once `shield_recharge_at_tick`
        # — the moment it was last hit, plus the out-of-combat delay — has
        # passed, and then it trickles back at the entity's own `shield_regen`
        # rate.
        # How often a regenerating shield ticks. Cadence, not a roster stat.
        REGEN_INTERVAL_TICKS = 20

        def self.step(world, dt)
          tick = world.tick
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive?

            expire_summon(world, e, tick)
            regenerate_shield(world, e, tick, dt)
          end
          resolve_deaths(world, tick)
        end

        # A summoned unit (a Mutated Guardian, a Neural Parasite trooper)
        # lives only as long as the ability that made it.
        def self.expire_summon(world, e, tick)
          expires = e.summon_expires_tick
          return if expires.nil? || expires > tick

          e.summon_expires_tick = nil
          e.hp = 0.0
          world.mark_dead(e)
        end

        def self.regenerate_shield(world, e, tick, dt)
          return if e.shield_max <= 0.0
          return if tick < e.shield_recharge_at_tick
          return unless (tick - e.last_hit_tick) % REGEN_INTERVAL_TICKS == 0
          return if e.shield >= e.total_shield_max(tick)

          e.shield += e.shield_regen * dt
          max = e.total_shield_max(tick)
          e.shield = max if e.shield > max
        end

        def self.resolve_deaths(world, tick)
          pending = world.pending_deaths
          return if pending.empty?

          until pending.empty?
            e = pending.shift
            world.emit(
              "e" => "death", "id" => e.id, "ty" => e.type_key,
              "x" => round3(e.x), "z" => round3(e.z), "y" => round3(e.z_world),
              "killer" => e.last_hit_by || 0
            )

            victim = world.state(e.player_id)
            if victim
              victim[:deaths] += 1
              release_queued_supply(world, e, victim)
            end
            killer = e.last_hit_by ? world.entity(e.last_hit_by) : nil
            if killer && killer.player_id != e.player_id
              ks = world.state(killer.player_id)
              ks[:kills] += 1 if ks
            end

            clear_references(world, e)
          end
          world.compact_living!
          nil
        end

        # A building that dies mid-production releases the supply its queue
        # had already reserved, so the dead queue does not sit on the cap.
        def self.release_queued_supply(world, e, victim)
          return unless e.is_building
          return if e.train_queue.empty?

          e.train_queue.each do |unit_type|
            defn = Starc::GameData.unit(unit_type)
            victim[:supply_pending] -= (defn&.dig("cost", "supply") || 0).to_i
          end
          e.train_queue.clear
          e.train_key = nil
          e.train_progress = nil
          victim[:supply_pending] = 0 if victim[:supply_pending].negative?
        end

        # Anything still pointing at a corpse is pointing at nothing. Deaths
        # are rare, so one allocation-free pass over the living list is
        # cheaper than maintaining back-references every tick.
        def self.clear_references(world, dead)
          i = 0
          while i < world.living.size
            o = world.living[i]
            i += 1
            o.target_id = 0 if o.target_id == dead.id
            next unless o.construct_id == dead.id

            # The building this worker was placing is gone. A worker that was
            # mining before the detour picks its shuttle back up.
            o.construct_id = 0
            o.state = if o.order == Starc::Sim::Entity::ORDER_HARVEST && o.worker?
                        "harvesting"
                      else
                        "idle"
                      end
          end
        end

        def self.round3(v)
          (v * 1000.0).round / 1000.0
        end
      end
    end
  end
end
