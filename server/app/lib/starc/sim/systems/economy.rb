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
          if node.nil? || !node.amount.positive?
            node = world.nearest_node(e.x, e.z, e.player_id)
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
              "x" => round3(e.x), "y" => round3(e.z)
            )
          end
          e.cargo -= amount
          e.cargo = 0.0 if e.cargo < 1.0
          e.harvest_phase = :to_node
          e.harvest_node_id = nil
          e.state = "harvesting"
        end

        # Geysers take priority as a drop-off; otherwise the nearest complete
        # friendly building, which is how the opening minutes work before a
        # player has built a refinery.
        def self.drop_off(world, e)
          best = nil
          best_d = Float::INFINITY
          geyser = nil
          geyser_d = Float::INFINITY
          world.each_living do |b|
            next unless b.alive? && b.is_building && b.complete?
            next unless b.player_id == e.player_id

            d = ((b.x - e.x) * (b.x - e.x)) + ((b.z - e.z) * (b.z - e.z))
            if b.geyser?
              next unless d < geyser_d

              geyser_d = d
              geyser = b
            end
            next unless d < best_d

            best_d = d
            best = b
          end
          geyser || best
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
