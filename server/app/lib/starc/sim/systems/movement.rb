# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 7 — movement.
      #
      # Units steer toward their order point at `speed * dt`, arrived within
      # their own radius, and then go idle or pop the next order off the queue.
      # Ground units are clamped to passable terrain (sliding along each axis
      # when the direct step is blocked); air units fly at a fixed altitude
      # over anything. A soft separation pass keeps units from stacking.
      #
      # Speed is `base_speed` times every live speed-affecting buff, so a
      # Stimpack, a Metabolic Boost, a Force Field and a Fungal Cloud all
      # compose here and nowhere else.
      module Movement
        ORDER_NONE = Starc::Sim::Entity::ORDER_NONE
        ORDER_MOVE = Starc::Sim::Entity::ORDER_MOVE
        ORDER_ATTACK = Starc::Sim::Entity::ORDER_ATTACK
        ORDER_PATROL = Starc::Sim::Entity::ORDER_PATROL

        ARRIVE_EPSILON = 0.05
        SEPARATION_MARGIN = 0.15
        # Two units closer than this to each other both get pushed, so
        # separation converges instead of oscillating.
        HALF_STEP = 0.5
        # Overlaps smaller than this are left alone. Without a deadband a
        # crowded fight spends the whole tick nudging units by fractions of a
        # millimetre, which is invisible and expensive.
        MIN_SEPARATION_PUSH = 0.01
        # Deterministic nudge for two units that occupy the exact same point,
        # which would otherwise divide by zero.
        OVERLAP_JITTER = 0.7

        def self.step(world, dt)
          tick = world.tick
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive? && e.unit?

            e.speed = e.base_speed * e.speed_multiplier(tick)

            case e.order
            when ORDER_MOVE
              e.state = "moving"
              arrive(world, e) if move_towards(world, e, e.order_x, e.order_z, dt)
            when ORDER_ATTACK
              chase(world, e, dt)
            when ORDER_PATROL
              patrol(world, e, dt)
            end

            follow_construction(world, e, dt)
          end
          separate(world)
        end

        # A worker walks to the site of whatever it is constructing. Returns
        # the building, or nil when there is nothing to build.
        def self.build_target(world, e)
          return nil unless e.construct_id.positive?

          b = world.entity(e.construct_id)
          b if b&.alive?
        end

        def self.follow_construction(world, e, dt)
          target = build_target(world, e)
          if target.nil?
            if e.construct_id.positive?
              e.construct_id = 0
              e.state = "idle" if e.state == "building"
            end
            return
          end
          e.state = "building"
          move_towards(world, e, target.x, target.z, dt)
        end

        # Steer toward (tx, tz). Returns true when the unit is already there
        # (within its own radius), so the caller can retire the order.
        def self.move_towards(world, e, tx, tz, dt)
          dx = tx - e.x
          dz = tz - e.z
          d2 = (dx * dx) + (dz * dz)
          arrive = e.radius + ARRIVE_EPSILON
          return true if d2 <= arrive * arrive

          d = Math.sqrt(d2)
          budget = e.speed * dt
          budget = d if budget > d
          if place(world, e, e.x + ((dx / d) * budget), e.z + ((dz / d) * budget))
            e.angle = Math.atan2(dx, dz)
          end
          budget >= d
        end

        # Instant relocation along a heading, capped at `distance`. Used by
        # Blink and by Charge's dash; terrain and world bounds still apply.
        def self.dash(world, e, tx, tz, distance)
          dx = tx - e.x
          dz = tz - e.z
          d = Math.sqrt((dx * dx) + (dz * dz))
          return false if d <= 0.0 || distance <= 0.0

          travel = d < distance ? d : distance
          moved = place(world, e, e.x + ((dx / d) * travel), e.z + ((dz / d) * travel))
          e.angle = Math.atan2(dx, dz)
          moved
        end

        def self.chase(world, e, dt)
          t = e.target_id.positive? ? world.entity(e.target_id) : nil
          if t.nil? || !t.alive?
            e.target_id = 0
            e.order = ORDER_NONE
            e.state = "idle"
            return
          end
          weapon = world.weapon_for(e)
          range = weapon ? weapon["range"] : 0.0
          if (e.dist2_to(t) <= range * range) && world.can_hit?(weapon, t)
            e.angle = Math.atan2(t.x - e.x, t.z - e.z)
            e.state = "attacking"
            return
          end
          e.state = "moving"
          move_towards(world, e, t.x, t.z, dt)
        end

        def self.patrol(world, e, dt)
          e.state = "moving"
          return unless move_towards(world, e, e.order_x, e.order_z, dt)

          # Ping-pong between the two points.
          e.order_x, e.patrol_x2 = e.patrol_x2, e.order_x
          e.order_z, e.patrol_z2 = e.patrol_z2, e.order_z
        end

        # Retire the finished order, or start the next one on the queue.
        def self.arrive(world, e)
          nxt = e.order_queue.shift
          if nxt.nil?
            e.order = ORDER_NONE
            e.target_id = 0
            e.state = "idle"
            e.order_x = e.x
            e.order_z = e.z
            return
          end
          e.order = nxt["order"]
          e.order_x = nxt["x"]
          e.order_z = nxt["z"]
          case e.order
          when ORDER_ATTACK
            e.target_id = nxt["target_id"]
            e.state = "attacking"
          when ORDER_PATROL
            e.patrol_x2 = nxt["x2"]
            e.patrol_z2 = nxt["y2"]
            e.state = "moving"
          else
            e.state = "moving"
          end
        end

        # Commit a new position. Ground units never end a step on impassable
        # ground: if the straight line is blocked, try sliding along one axis
        # before giving up. Air units ignore the surface entirely.
        def self.place(world, e, x, z)
          return false if e.is_building

          size = world.size.to_f
          x = 0.0 if x.negative?
          x = size if x > size
          z = 0.0 if z.negative?
          z = size if z > size
          return false if x == e.x && z == e.z

          unless e.is_air
            unless world.terrain.passable?(x, z)
              if world.terrain.passable?(x, e.z)
                z = e.z
              elsif world.terrain.passable?(e.x, z)
                x = e.x
              else
                return false
              end
            end
          end
          e.x = x
          e.z = z
          world.index.update_position(e)
          true
        end

        # Soft body separation. Units nudge each other apart; buildings are
        # immovable, so a unit is pushed fully clear of them. Air units ignore
        # everything below them.
        def self.separate(world)
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive? && e.unit?

            reach = (e.radius * 2.0) + SEPARATION_MARGIN
            world.index.query_radius(e.x, e.z, reach, e.id).each do |o|
              next unless o.alive?

              if o.is_building
                push_out_of_building(world, e, o)
              elsif o.unit? && (e.is_air == o.is_air)
                push_apart(world, e, o)
              end
            end
          end
        end

        def self.push_apart(world, a, b)
          min = a.radius + b.radius + SEPARATION_MARGIN
          dx = b.x - a.x
          dz = b.z - a.z
          d2 = (dx * dx) + (dz * dz)
          return if d2 >= min * min

          if d2 < 1e-12
            # Perfectly coincident: separate on a fixed per-id heading so the
            # result is identical on every replay.
            angle = a.id * OVERLAP_JITTER
            dx = Math.cos(angle)
            dz = Math.sin(angle)
            d2 = 1.0
          end
          d = Math.sqrt(d2)
          push = (min - d) * HALF_STEP
          return if push < MIN_SEPARATION_PUSH

          ux = dx / d
          uz = dz / d
          place(world, a, a.x - (ux * push), a.z - (uz * push))
          place(world, b, b.x + (ux * push), b.z + (uz * push))
        end

        def self.push_out_of_building(world, e, b)
          return if e.is_air

          min = e.radius + b.radius
          dx = e.x - b.x
          dz = e.z - b.z
          d2 = (dx * dx) + (dz * dz)
          return if d2 >= min * min

          if d2 < 1e-12
            angle = e.id * OVERLAP_JITTER
            dx = Math.cos(angle)
            dz = Math.sin(angle)
            d2 = 1.0
          end
          d = Math.sqrt(d2)
          push = min - d
          return if push < MIN_SEPARATION_PUSH

          place(world, e, e.x + ((dx / d) * push), e.z + ((dz / d) * push))
        end
      end
    end
  end
end
