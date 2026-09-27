# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 5 — ability effects.
      #
      # Every `effect` in shared/schema.json is honoured: damage, heal, shield,
      # speed_boost, attack_boost, armor_boost, cloak, blink, web, slow,
      # reveal and spawn. `cooldown` and `duration_s` come from the roster —
      # never a literal here.
      #
      # Two shapes of effect exist:
      #
      #   * passive buffs — a `{ ability_key => expiry_tick }` entry on the
      #     target. `speed_boost` and `attack_boost`/`armor_boost`/`cloak`
      #     are read straight out of it every tick by the entity.
      #   * ticking effects — an `Effect` record that re-applies damage, heal
      #     or shield every `TICK_INTERVAL_TICKS`, for abilities with a
      #     duration (a Psionic Storm rains for its full duration, a Photon
      #     Overcharge keeps topping the target up). An effect with a radius
      #     and no single target is an aura: it hits everything in the radius
      #     each time it ticks.
      #
      # `ability` commands carry only `ids` and `ability` (PROTOCOL.md §4), so
      # point-targeted abilities use the caster's current order point and
      # `ally_unit`/`enemy_unit` abilities use its current target, falling
      # back to the nearest valid one. That is the only place the protocol
      # leaves a gap, and the fallback is deterministic.
      module Abilities
        # Re-application cadence for damage/heal/shield effects.
        TICK_INTERVAL_TICKS = 10
        # Fallback for `spawn` abilities that declare no duration: without a
        # floor, a zero-cooldown summon would fire every single tick.
        SUMMON_COOLDOWN_S = 10.0
        # How far a unit may act on an `ally_unit`/`enemy_unit` ability when
        # it has no explicit target.
        ABILITY_TARGET_RANGE = 5.0
        # "Until death" expiry. A plain Integer, because PROTOCOL.md §0
        # forbids NaN and Infinity on the wire.
        PERMANENT_TICK = 4_611_686_018_427_387_904

        Effect = Struct.new(:caster_id, :ability_key, :target_id, :radius,
                            :expires_tick, :next_tick, :hostile, :x, :y)

        # Returns nil on success, or a protocol rejection code.
        def self.cast(world, entity, key)
          meta = world.registry[key]
          return "no_such_ability" if meta.nil?
          return "no_such_ability" if entity.ability(key).nil?
          return "cooldown" if entity.on_cooldown?(key, world.tick)

          cost = world.registry.cost(key)
          return "insufficient_resources" if cost.positive? && !world.spend(entity.player_id, cost.to_i)

          apply(world, entity, key, meta)
          nil
        end

        def self.apply(world, caster, key, meta)
          tick = world.tick
          effect = meta["effect"]
          duration = world.registry.duration_s(key)
          radius = meta["radius"]
          cooldown = world.registry.cooldown_s(key)
          # A summon with no cooldown of its own would fire every tick; its
          # duration is the natural recast lock.
          cooldown = [cooldown, duration || SUMMON_COOLDOWN_S].max if effect == "spawn"
          caster.set_cooldown!(key, cooldown, tick, world.ticks_per_second) if cooldown.positive?

          case effect
          when "blink" then blink(world, caster, meta)
          when "spawn" then summon(world, caster, key, meta)
          when "damage" then cast_damage(world, caster, key, meta, duration, radius)
          when "heal" then cast_heal(world, caster, key, meta, duration)
          when "shield" then cast_shield(world, caster, key, meta, duration, radius)
          when "speed_boost" then cast_speed_boost(world, caster, key, duration)
          when "slow", "web" then cast_slow(world, caster, key, meta, duration, radius)
          when "attack_boost", "armor_boost", "cloak", "reveal" then caster.apply_buff(key, expiry(world, duration))
          end

          world.emit(
            "e" => "ability", "id" => caster.id, "ab" => key,
            "x" => round3(caster.x), "y" => round3(caster.z), "z" => round3(caster.z_world)
          )
        end

        # --- effects ---------------------------------------------------------

        def self.cast_speed_boost(world, caster, key, duration)
          caster.apply_buff(key, expiry(world, duration))
          # `charge` is a speed boost aimed at a point: it is a dash, not a
          # walk. Cover the distance the boost would carry it in `duration_s`.
          distance = world.registry.magnitude(key) * (duration || 0.0)
          return unless distance.positive?

          Starc::Sim::Systems::Movement.dash(world, caster, caster.order_x, caster.order_z, distance)
        end

        def self.cast_damage(world, caster, key, meta, duration, radius)
          target = resolve_target(world, caster, meta["target"])
          if target.nil? && meta["target"] != "point"
            return
          end

          point = meta["target"] == "point"
          x = point ? caster.order_x : target.x
          z = point ? caster.order_z : target.z
          target_id = point ? 0 : target.id
          if duration&.positive?
            world.effects << make_effect(world, caster, key, target_id, radius, duration, true, x, z)
          else
            strike(world, caster, key, radius, target_id, x, z)
          end
        end

        def self.cast_heal(world, caster, key, meta, duration)
          target = resolve_target(world, caster, meta["target"])
          return if target.nil?

          if duration&.positive?
            world.effects << make_effect(world, caster, key, target.id, nil, duration, false, target.x, target.z)
          else
            world.heal(target, world.registry.magnitude(key))
          end
        end

        def self.cast_shield(world, caster, key, meta, duration, radius)
          if radius&.positive?
            # An aura: a shield battery keeps topping up everything nearby for
            # as long as the ability is up.
            world.effects << make_effect(world, caster, key, 0, radius,
                                         aura_duration(world, duration), false, caster.x, caster.z)
            return
          end
          target = resolve_target(world, caster, meta["target"])
          return if target.nil?

          target.apply_buff(key, expiry(world, duration))
          world.add_shield(target, world.registry.magnitude(key))
        end

        def self.cast_slow(world, caster, key, meta, duration, radius)
          if radius&.positive?
            world.effects << make_effect(world, caster, key, 0, radius,
                                         aura_duration(world, duration), true,
                                         caster.order_x, caster.order_z)
            return
          end
          target = resolve_target(world, caster, meta["target"])
          return if target.nil?

          target.apply_buff(key, expiry(world, duration))
        end

        # An aura with no declared duration still needs to live long enough to
        # tick at least once; without this it would be born already expired.
        def self.aura_duration(world, duration)
          return duration if duration&.positive?

          TICK_INTERVAL_TICKS / world.ticks_per_second
        end

        def self.strike(world, caster, key, radius, target_id, x, z)
          damage = world.registry.magnitude(key) * (1.0 + caster.attack_bonus(world.tick))
          if target_id.positive?
            target = world.entity(target_id)
            if target&.alive? && world.enemies?(target.player_id, caster.player_id)
              world.apply_damage(target, damage, source_id: caster.id)
            end
            return if radius.nil? || !radius.positive?

            centre_x = target ? target.x : x
            centre_z = target ? target.z : z
            splash(world, caster, damage, radius, centre_x, centre_z, target_id)
          else
            splash(world, caster, damage, radius, x, z, 0)
          end
        end

        def self.splash(world, caster, damage, radius, x, z, except_id)
          return unless radius&.positive?

          world.index.query_radius(x, z, radius, except_id).each do |e|
            next unless e.alive?
            next unless world.enemies?(e.player_id, caster.player_id)

            world.apply_damage(e, damage * Starc::Sim::World::DEFAULT_SPLASH_DAMAGE_PCT, source_id: caster.id)
          end
        end

        # --- blink and summon -------------------------------------------------

        # Teleport up to `magnitude` metres toward the order point, clamped to
        # the world and to passable ground for ground units.
        def self.blink(world, caster, meta)
          reach = meta["magnitude"].to_f
          dx = caster.order_x - caster.x
          dz = caster.order_z - caster.z
          d = Math.sqrt((dx * dx) + (dz * dz))
          return if d <= 0.0 || reach <= 0.0

          travel = d < reach ? d : reach
          Starc::Sim::Systems::Movement.dash(world, caster, caster.order_x, caster.order_z, travel)
        end

        def self.summon(world, caster, key, meta)
          spawn_key = world.registry.spawn_key(key)
          tick = world.tick
          if meta["target"] == "enemy_unit"
            # No `spawn` key means "turn the target into one of mine" — the
            # Neural Parasite case.
            target = resolve_target(world, caster, "enemy_unit")
            return if target.nil? || !target.unit?

            spawn_key ||= caster.type_key
            world.mark_dead(target)
            unit = world.spawn_entity(spawn_key, caster.player_id, target.x, target.z)
          else
            point = meta["target"] == "point"
            x = point ? caster.order_x : caster.x
            z = point ? caster.order_z : caster.z
            spawn_key ||= caster.type_key
            unit = world.spawn_entity(spawn_key, caster.player_id, x, z)
          end
          return if unit.nil?

          duration = world.registry.duration_s(key)
          unit.summon_expires_tick = tick + (duration * world.ticks_per_second).ceil if duration&.positive?
          unit
        end

        # --- per-tick effects -------------------------------------------------

        def self.step(world, dt)
          tick = world.tick
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            e.expire_buffs!(tick)
          end
          return if world.effects.empty?

          j = 0
          while j < world.effects.size
            fx = world.effects[j]
            if fx.expires_tick <= tick || world.entity(fx.caster_id).nil?
              world.effects.delete_at(j)
              next
            end
            if fx.next_tick <= tick
              apply_effect(world, fx)
              fx.next_tick = tick + TICK_INTERVAL_TICKS
            end
            j += 1
          end
        end

        def self.apply_effect(world, fx)
          caster = world.entity(fx.caster_id)
          return if caster.nil? || !caster.alive?

          case world.registry.effect(fx.ability_key)
          when "damage" then strike(world, caster, fx.ability_key, fx.radius, fx.target_id, fx.x, fx.y)
          when "heal" then tick_heal(world, caster, fx)
          when "shield" then tick_shield(world, caster, fx)
          when "slow", "web" then tick_slow(world, caster, fx)
          end
        end

        def self.tick_heal(world, caster, fx)
          amount = world.registry.magnitude(fx.ability_key)
          if fx.radius&.positive?
            aura(world, caster, fx, false) { |e| world.heal(e, amount) }
          elsif fx.target_id.positive?
            target = world.entity(fx.target_id)
            world.heal(target, amount) if target&.alive?
          end
        end

        def self.tick_shield(world, caster, fx)
          amount = world.registry.magnitude(fx.ability_key)
          if fx.radius&.positive?
            aura(world, caster, fx, false) { |e| world.add_shield(e, amount) }
          elsif fx.target_id.positive?
            target = world.entity(fx.target_id)
            if target&.alive?
              target.apply_buff(fx.ability_key, expiry(world, world.registry.duration_s(fx.ability_key)))
              world.add_shield(target, amount)
            end
          end
        end

        def self.tick_slow(world, caster, fx)
          expiry_tick = fx.expires_tick
          if fx.radius&.positive?
            aura(world, caster, fx, true) { |e| e.apply_buff(fx.ability_key, expiry_tick) }
          elsif fx.target_id.positive?
            target = world.entity(fx.target_id)
            target.apply_buff(fx.ability_key, expiry_tick) if target&.alive?
          end
        end

        # Every living entity in the effect's radius, filtered by side. An
        # aura follows its caster: a shield battery keeps covering whoever is
        # next to the archon right now, not whoever was there when it started.
        def self.aura(world, caster, fx, hostile)
          radius = fx.radius
          return unless radius&.positive?

          world.index.query_radius(caster.x, caster.z, radius).each do |e|
            next unless e.alive?
            same_side = world.allies?(e.player_id, caster.player_id)
            next if hostile ? same_side : !same_side

            yield e
          end
        end

        # --- helpers ----------------------------------------------------------

        def self.make_effect(world, caster, key, target_id, radius, duration, hostile, x, z)
          tps = world.ticks_per_second
          Effect.new(
            caster.id, key, target_id, radius,
            world.tick + (duration * tps).ceil,
            world.tick + TICK_INTERVAL_TICKS,
            hostile, x, z
          )
        end

        def self.expiry(world, duration)
          return PERMANENT_TICK if duration.nil?

          world.tick + (duration * world.ticks_per_second).ceil
        end

        # Resolve an ability's non-point target from the caster's own state.
        def self.resolve_target(world, caster, kind)
          case kind
          when "enemy_unit" then resolve_enemy(world, caster)
          when "ally_unit" then resolve_ally(world, caster)
          end
        end

        def self.resolve_enemy(world, caster)
          if caster.target_id.positive?
            t = world.entity(caster.target_id)
            return t if t&.alive? && world.enemies?(t.player_id, caster.player_id)
          end
          world.find_nearest_enemy(caster, ABILITY_TARGET_RANGE)
        end

        def self.resolve_ally(world, caster)
          if caster.target_id.positive?
            t = world.entity(caster.target_id)
            return t if t&.alive? && world.allies?(t.player_id, caster.player_id)
          end
          # Repairing yourself is the common case, so prefer it.
          return caster if caster.unit?

          best = nil
          best_d = ABILITY_TARGET_RANGE * ABILITY_TARGET_RANGE
          world.index.query_radius(caster.x, caster.z, ABILITY_TARGET_RANGE, caster.id).each do |e|
            next unless e.alive? && e.unit?
            next unless world.allies?(e.player_id, caster.player_id)

            d = caster.dist2_to(e)
            next if d > best_d

            best_d = d
            best = e
          end
          best
        end

        def self.round3(v)
          (v * 1000.0).round / 1000.0
        end
      end
    end
  end
end
