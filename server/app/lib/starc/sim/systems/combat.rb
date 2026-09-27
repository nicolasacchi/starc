# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 8 — weapon fire and projectiles.
      #
      # A shooter with a live target in range and a ready weapon fires: the
      # cooldown is set from the weapon, a `shot` event goes out, and either
      # the damage lands immediately (`melee` and `beam` have no travel time)
      # or a projectile is spawned that homes on the target and resolves in
      # phase 9. Splash goes through the spatial index.
      module Combat
        # Weapons that hit the instant they are fired.
        INSTANT_WEAPONS = %w[melee beam].freeze
        # Where a shot leaves the muzzle, as a fraction of the shooter's
        # height. Purely cosmetic — the damage maths never sees it.
        MUZZLE_FRACTION = 0.6
        IMPACT_FRACTION = 0.5

        def self.step(world, dt)
          tick = world.tick
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive?

            e.cooldown -= dt if e.cooldown.positive?
            weapon = world.weapon_for(e)
            next if weapon.nil? || e.cooldown.positive?
            next unless e.target_id.positive?

            t = world.entity(e.target_id)
            next if t.nil? || !t.alive?
            next unless world.can_hit?(weapon, t)

            range = weapon["range"]
            next if e.dist2_to(t) > range * range

            e.cooldown = weapon["cooldown"]
            e.angle = Math.atan2(t.x - e.x, t.z - e.z)
            fire(world, e, t, weapon, weapon["damage"] + e.attack_bonus(tick), tick)
          end
          advance(world, dt)
        end

        def self.fire(world, shooter, target, weapon, damage, tick)
          shooter_z = shooter.z_world + (shooter.height * MUZZLE_FRACTION)
          target_z = world.height_for(target) + (target.height * IMPACT_FRACTION)
          world.emit(
            "e" => "shot", "id" => shooter.id,
            "x" => round3(shooter.x), "z" => round3(shooter.z), "y" => round3(shooter_z),
            "tx" => round3(target.x), "tz" => round3(target.z), "ty" => round3(target_z)
          )

          splash = weapon["splash"]
          if INSTANT_WEAPONS.include?(weapon["weapon"])
            resolve_hit(world, shooter, target, damage, splash)
            return
          end

          projectile = Starc::Sim::Projectile.new(
            id: world.next_projectile_id,
            owner_id: shooter.id,
            weapon: weapon["weapon"],
            x: shooter.x, y: shooter.z, z: shooter_z,
            tx: target.x, ty: target.z, tz: target_z,
            target_id: target.id,
            speed: weapon["projectile_speed"],
            damage: damage,
            splash_radius: splash && splash["radius"],
            splash_pct: splash && splash["damage_pct"]
          )
          projectile.created_tick = tick
          world.projectiles << projectile
          world.emit(projectile.to_event_hash)
        end

        # Fly every projectile one step toward its aim point. Aiming at a
        # living target tracks it; otherwise the shot flies on to the point it
        # was launched at and expires there.
        def self.advance(world, dt)
          i = 0
          while i < world.projectiles.size
            p = world.projectiles[i]
            target = p.target_id.positive? ? world.entity(p.target_id) : nil
            if target&.alive?
              p.tx = target.x
              p.ty = target.z
              p.tz = world.height_for(target) + (target.height * IMPACT_FRACTION)
            end

            dx = p.tx - p.x
            dy = p.ty - p.y
            dz = p.tz - p.z
            distance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz))
            travel = p.speed * dt

            if distance <= travel || distance < 1e-9
              p.arrive(p.tx, p.ty, p.tz)
              land(world, p)
              world.projectiles.delete_at(i)
              next
            end
            p.advance((dx / distance) * travel, (dy / distance) * travel, (dz / distance) * travel)
            i += 1
          end
        end

        # A splash weapon damages the impact point's whole neighbourhood, the
        # target included. A plain shot damages the target alone.
        def self.land(world, p)
          shooter = world.entity(p.owner_id)
          return if shooter.nil?

          target = p.target_id.positive? ? world.entity(p.target_id) : nil
          if p.splash?
            resolve_hit(world, shooter, target, p.damage,
                        { "radius" => p.splash_radius, "damage_pct" => p.splash_pct },
                        p.x, p.z, 0)
          elsif target&.alive? && world.enemies?(target.player_id, shooter.player_id)
            world.apply_damage(target, p.damage, source_id: p.owner_id)
          end
        end

        def self.resolve_hit(world, shooter, target, damage, splash, x = nil, z = nil, except_id = 0)
          centre_x = x || target&.x || shooter.x
          centre_z = z || target&.z || shooter.z
          unless splash.nil?
            radius = splash["radius"]
            pct = splash["damage_pct"] || Starc::Sim::World::DEFAULT_SPLASH_DAMAGE_PCT
            if radius&.positive?
              world.index.query_radius(centre_x, centre_z, radius, except_id).each do |e|
                next unless e.alive?
                next unless world.enemies?(e.player_id, shooter.player_id)

                world.apply_damage(e, damage * pct, source_id: shooter.id)
              end
              return
            end
          end
          return if target.nil? || !target.alive?

          world.apply_damage(target, damage, source_id: shooter.id)
        end

        def self.round3(v)
          (v * 1000.0).round / 1000.0
        end
      end
    end
  end
end
