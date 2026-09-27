# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 4 — harvesting and the rest of the economy.
      #
      # A worker with a `harvest` block and a harvest order runs a four-state
      # shuttle: walk to the nearest node with minerals left, mine up to
      # `capacity` at `rate` per second, walk to the drop-off, deposit. The
      # deposit emits `res` and accumulates into `resources_mined`.
      #
      # Maps declare mineral clusters but no vespene geysers, so vespene is
      # refined passively by each complete geyser building
      # (`refinery`/`extractor`/`assimilator`). That rate is a simulation
      # constant, not a roster stat.
      module Economy
        # Workers stop this far out rather than walking into the node or the
        # building they are servicing.
        HARVEST_REACH = 2.0
        DROP_OFF_REACH = 3.0
        VESPENE_PER_GEYSER_PER_SECOND = 0.5

        ORDER_HARVEST = Starc::Sim::Entity::ORDER_HARVEST
        ORDER_NONE = Starc::Sim::Entity::ORDER_NONE

        def self.step(world, dt)
          accrue_vespene(world, dt)
          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive? && e.worker? && e.order == ORDER_HARVEST
            next if e.construct_id.positive?

            case e.harvest_phase
            when :to_node then to_node(world, e, dt)
            when :mining then mine(world, e, dt)
            when :to_base then to_base(world, e, dt)
            when :unloading then unload(world, e)
            else e.harvest_phase = :to_node
            end
          end
        end

        # Every complete geyser trickles vespene. The fractional part is
        # carried so the yield does not depend on the tick length.
        def self.accrue_vespene(world, dt)
          i = 0
          while i < world.living.size
            g = world.living[i]
            i += 1
            next unless g.alive? && g.geyser? && g.complete?

            st = world.state(g.player_id)
            next unless st

            st[:vespene_frac] += VESPENE_PER_GEYSER_PER_SECOND * dt
            whole = st[:vespene_frac].floor
            next unless whole.positive?

            st[:vespene_frac] -= whole
            st[:vespene] += whole
          end
        end

        def self.to_node(world, e, dt)
          node = e.harvest_node_id ? world.node(e.harvest_node_id) : nil
          # `node_still_works?` also covers distance, so a worker that was
          # pulled to the far side of the map — an expansion, a new base —
          # re-picks the field it is actually standing in rather than
          # trudging back to the one it left.
          unless world.node_still_works?(e, node)
            node = world.nearest_node(e.x, e.z, e.player_id, e.id)
            if node.nil?
              # The map is mined out. There is nothing left to shuttle for.
              e.state = "idle"
              e.harvest_phase = :none
              e.order = ORDER_NONE
              return
            end
            e.harvest_node_id = node.id
          end

          e.state = "harvesting"
          e.order_x = node.x
          e.order_z = node.y
          if within?(e, node.x, node.y, HARVEST_REACH)
            e.harvest_phase = :mining
            return
          end
          Starc::Sim::Systems::Movement.move_towards(world, e, node.x, node.y, dt)
        end

        def self.mine(world, e, dt)
          node = e.harvest_node_id ? world.node(e.harvest_node_id) : nil
          if node.nil? || !node.amount.positive?
            e.harvest_phase = :to_node
            e.harvest_node_id = nil
            return
          end
          e.state = "harvesting"

          capacity = e.harvest_capacity
          room = capacity - e.cargo
          return if room <= 0

          mined = e.harvest_rate * dt
          mined = room if mined > room
          mined = node.amount if mined > node.amount
          e.cargo += mined
          node.amount -= mined

          return if node.amount.positive? && e.cargo < capacity

          e.harvest_phase = :to_base
        end

        def self.to_base(world, e, dt)
          drop = drop_off(world, e)
          if drop.nil?
            e.state = "idle"
            return
          end
          e.state = "returning"
          e.order_x = drop.x
          e.order_z = drop.z
          if within?(e, drop.x, drop.z, DROP_OFF_REACH)
            e.harvest_phase = :unloading
            return
          end
          Starc::Sim::Systems::Movement.move_towards(world, e, drop.x, drop.z, dt)
        end

        def self.unload(world, e)
          e.state = "returning"
          amount = e.cargo.floor
          if amount.positive?
            st = world.state(e.player_id)
            st[:minerals] += amount
            st[:resources_mined] += amount
            world.emit(
              "e" => "res", "pl" => e.player_id, "amount" => amount,
              "x" => round3(e.x), "z" => round3(e.z)
            )
          end
          e.cargo -= amount
          e.cargo = 0.0 if e.cargo < 1.0
          e.harvest_phase = :to_node
          e.harvest_node_id = nil
          e.state = "harvesting"
        end

        # Where a worker unloads: the nearest complete friendly building. Early
        # on that is the main building, which is how the opening minutes work
        # before anyone has built a depot or a refinery. Geysers are buildings
        # like any other here — their own job is refining vespene.
        #
        # The candidate list is cached per player and rebuilt only when that
        # player's set of buildings changes. Picking the nearest out of a
        # handful of buildings is free; rescanning the whole entity table once
        # per worker per tick would make the economy O(workers x entities).
        def self.drop_off(world, e)
          st = world.state(e.player_id)
          return nil if st.nil?

          best = nil
          best_d = Float::INFINITY
          list = drop_offs(world, st)
          i = 0
          while i < list.size
            entry = list[i]
            i += 1
            d = ((entry[0] - e.x) * (entry[0] - e.x)) + ((entry[1] - e.z) * (entry[1] - e.z))
            next if d >= best_d

            candidate = world.entity(entry[2])
            next if candidate.nil? || !candidate.alive?

            best_d = d
            best = candidate
          end
          best
        end

        # `[[x, z, id], ...]` for every complete friendly building, rebuilt
        # only when the player's building set changes.
        def self.drop_offs(world, st)
          cached = st[:drop_offs]
          return cached if cached && st[:drop_offs_version] == st[:building_version]

          list = []
          world.each_living do |b|
            next unless b.alive? && b.is_building && b.complete? && b.player_id == st[:id]

            list << [b.x, b.z, b.id]
          end
          st[:drop_offs] = list
          st[:drop_offs_version] = st[:building_version]
          list
        end

        def self.within?(e, x, z, reach)
          dx = x - e.x
          dz = z - e.z
          (dx * dx) + (dz * dz) <= reach * reach
        end

        def self.round3(v)
          (v * 1000.0).round / 1000.0
        end
      end
    end
  end
end
