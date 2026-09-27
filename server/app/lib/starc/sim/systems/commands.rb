# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 1 — command application.
      #
      # Every command in a `game:command` batch is validated independently
      # (PROTOCOL.md §4): a bad entity id or an unaffordable unit drops that
      # one command and leaves the rest of the batch standing. Rejections are
      # always reported against the command's index in the batch, and the
      # codes come from `CommandResult::CODES` — the protocol's fixed list,
      # never an ad-hoc string.
      module Commands
        MAX_IDS_PER_COMMAND = 256
        MAX_CHAT_LENGTH = 280
        # Production queue depth, per building.
        MAX_TRAIN_QUEUE = 10
        MAX_TRAIN_COUNT = 10
        # How far from itself a worker may place a new building.
        BUILD_REACH = 10.0

        ORDER_NONE = Starc::Sim::Entity::ORDER_NONE
        ORDER_MOVE = Starc::Sim::Entity::ORDER_MOVE
        ORDER_ATTACK = Starc::Sim::Entity::ORDER_ATTACK
        ORDER_HARVEST = Starc::Sim::Entity::ORDER_HARVEST
        ORDER_PATROL = Starc::Sim::Entity::ORDER_PATROL

        # Phase 1 is a documented no-op. `World#apply_commands` validates and
        # applies a batch the moment it arrives, and no simulation state
        # changes between that moment and the next `step!`, so applying on
        # receipt is identical to applying here. See the step-order note in
        # `Starc::Sim::World`.
        def self.step(_world, _dt)
          nil
        end

        def self.apply(world, player_id, commands)
          result = Starc::Sim::CommandResult.new
          unless commands.is_a?(Array)
            result.reject!(0, "invalid_payload", "commands must be an array")
            return result
          end
          if world.player(player_id).nil?
            commands.each_index do |i|
              result.reject!(i, "not_owner", "player #{player_id} is not in this match")
            end
            return result
          end

          commands.each_with_index { |cmd, index| apply_one(world, player_id, cmd, index, result) }
          result
        end

        def self.apply_one(world, player_id, cmd, index, result)
          unless cmd.is_a?(Hash)
            result.reject!(index, "invalid_payload", "command must be an object")
            return result
          end
          type = value(cmd, "c")
          handler = HANDLERS[type]
          if handler.nil?
            result.reject!(index, "invalid_payload", "unknown command #{type.inspect}")
            return result
          end
          handler.call(world, player_id, cmd, index, result)
          result
        end

        # --- shared validation ---------------------------------------------

        # Resolve `ids` to a list of live entities the player owns. Any problem
        # rejects the whole command; ownership is enforced here so no handler
        # can forget it.
        def self.resolve_ids(world, player_id, cmd, index, result)
          ids = value(cmd, "ids")
          unless ids.is_a?(Array) && !ids.empty? && ids.size <= MAX_IDS_PER_COMMAND
            result.reject!(index, "invalid_payload", "ids must be 1..#{MAX_IDS_PER_COMMAND} entity ids")
            return nil
          end

          list = Array.new(ids.size)
          i = 0
          while i < ids.size
            raw = ids[i]
            unless raw.is_a?(Integer)
              result.reject!(index, "invalid_payload", "entity id must be an integer")
              return nil
            end
            e = world.entity(raw)
            if e.nil?
              result.reject!(index, "no_such_entity", "no entity #{raw}")
              return nil
            end
            unless e.alive?
              result.reject!(index, "dead_entity", "entity #{raw} is dead")
              return nil
            end
            unless e.player_id == player_id
              result.reject!(index, "not_owner", "entity #{raw} is not yours")
              return nil
            end
            list[i] = e
            i += 1
          end
          list
        end

        def self.resolve_one(world, player_id, cmd, key, index, result)
          raw = value(cmd, key)
          unless raw.is_a?(Integer)
            result.reject!(index, "invalid_payload", "#{key} must be an entity id")
            return nil
          end
          e = world.entity(raw)
          if e.nil?
            result.reject!(index, "no_such_entity", "no entity #{raw}")
            return nil
          end
          unless e.alive?
            result.reject!(index, "dead_entity", "entity #{raw} is dead")
            return nil
          end
          unless e.player_id == player_id
            result.reject!(index, "not_owner", "entity #{raw} is not yours")
            return nil
          end
          e
        end

        def self.numeric?(v)
          v.is_a?(Integer) || v.is_a?(Float)
        end

        # World-space destination, rejected when it leaves the map.
        # PROTOCOL.md §4 constrains coordinates to the world box.
        def self.destination(world, cmd, index, result)
          x = value(cmd, "x")
          z = value(cmd, "z")
          unless numeric?(x) && numeric?(z)
            result.reject!(index, "invalid_payload", "x and z must be numbers")
            return nil
          end
          unless world.terrain.in_bounds?(x, z)
            result.reject!(index, "out_of_range", "destination is outside the map")
            return nil
          end
          [x.to_f, z.to_f]
        end

        def self.value(cmd, key)
          v = cmd[key]
          v.nil? ? cmd[key.to_sym] : v
        end

        def self.queued?(cmd)
          value(cmd, "queue") == true
        end

        def self.missing_requirements(world, player_id, defn)
          required = defn["required_buildings"] || []
          return [] if required.empty?

          present = {}
          world.each_living do |e|
            next unless e.player_id == player_id
            next unless e.is_building && e.complete?

            present[e.type_key] = true
          end
          required.reject { |k| present[k] }
        end

        # --- handlers --------------------------------------------------------

        HANDLERS = {}

        def self.register(name, &block)
          HANDLERS[name] = block
        end

        register("move") do |world, player_id, cmd, index, result|
          units = resolve_ids(world, player_id, cmd, index, result) or next result
          dest = destination(world, cmd, index, result) or next result
          x, z = dest
          order = { "order" => ORDER_MOVE, "x" => x, "z" => z }
          units.each do |u|
            next unless u.unit?

            if queued?(cmd)
              u.queue_order!(order)
            else
              u.order_queue.clear
              u.order = ORDER_MOVE
              u.order_x = x
              u.order_z = z
              u.target_id = 0
              u.hold_position = false
              u.state = u.construct_id.positive? ? "building" : "moving"
            end
          end
          result.accept!
        end

        register("attack") do |world, player_id, cmd, index, result|
          units = resolve_ids(world, player_id, cmd, index, result) or next result
          raw = value(cmd, "target_id")
          unless raw.is_a?(Integer)
            result.reject!(index, "invalid_payload", "target_id must be an entity id")
            next result
          end
          target = world.entity(raw)
          if target.nil?
            result.reject!(index, "no_such_entity", "no entity #{raw}")
            next result
          end
          unless target.alive?
            result.reject!(index, "invalid_target", "target #{raw} is dead")
            next result
          end
          if target.player_id == player_id || world.allies?(target.player_id, player_id)
            result.reject!(index, "invalid_target", "target #{raw} is not an enemy")
            next result
          end

          order = { "order" => ORDER_ATTACK, "target_id" => target.id }
          units.each do |u|
            next unless u.unit?

            if queued?(cmd)
              u.queue_order!(order)
            else
              u.order_queue.clear
              u.order = ORDER_ATTACK
              u.target_id = target.id
              u.hold_position = false
              u.state = "attacking"
            end
          end
          result.accept!
        end

        register("stop") do |world, player_id, cmd, index, result|
          units = resolve_ids(world, player_id, cmd, index, result) or next result
          units.each do |u|
            next unless u.unit?

            u.harvest_phase = :none
            u.clear_orders!
          end
          result.accept!
        end

        register("hold") do |world, player_id, cmd, index, result|
          units = resolve_ids(world, player_id, cmd, index, result) or next result
          units.each do |u|
            next unless u.unit?

            u.clear_orders!
            u.harvest_phase = :none
            u.hold_position = true
            u.state = "idle"
          end
          result.accept!
        end

        register("patrol") do |world, player_id, cmd, index, result|
          units = resolve_ids(world, player_id, cmd, index, result) or next result
          dest = destination(world, cmd, index, result) or next result
          x2 = value(cmd, "x2")
          z2 = value(cmd, "z2")
          unless numeric?(x2) && numeric?(z2) && world.terrain.in_bounds?(x2, z2)
            result.reject!(index, "out_of_range", "patrol end is outside the map")
            next result
          end
          x, z = dest
          order = { "order" => ORDER_PATROL, "x" => x, "z" => z,
                    "x2" => x2.to_f, "y2" => z2.to_f }
          units.each do |u|
            next unless u.unit?

            if queued?(cmd)
              u.queue_order!(order)
            else
              u.order_queue.clear
              u.order = ORDER_PATROL
              u.order_x = x
              u.order_z = z
              u.patrol_x2 = x2.to_f
              u.patrol_z2 = z2.to_f
              u.hold_position = false
              u.state = "moving"
            end
          end
          result.accept!
        end

        register("train") do |world, player_id, cmd, index, result|
          building = resolve_one(world, player_id, cmd, "building_id", index, result) or next result
          unless building.is_building
            result.reject!(index, "invalid_payload", "entity #{building.id} is not a building")
            next result
          end
          unless building.complete?
            result.reject!(index, "not_ready", "building #{building.id} is still under construction")
            next result
          end

          unit_type = value(cmd, "unit_type")
          defn = unit_type.is_a?(String) ? Starc::GameData.unit(unit_type) : nil
          if defn.nil? || Starc::GameData.race_of(unit_type) != world.player_race(player_id)
            result.reject!(index, "no_such_unit_type", "no #{unit_type.inspect} in your roster")
            next result
          end
          unless building.produce?(unit_type)
            result.reject!(index, "no_such_unit_type", "#{building.type_key} cannot build #{unit_type}")
            next result
          end

          count = value(cmd, "count")
          count = count.is_a?(Integer) ? count : 1
          count = 1 if count < 1
          count = MAX_TRAIN_COUNT if count > MAX_TRAIN_COUNT

          if building.train_queue.size + count > MAX_TRAIN_QUEUE
            result.reject!(index, "queue_full", "training queue is full")
            next result
          end

          cost = defn["cost"] || {}
          minerals = (cost["minerals"] || 0).to_i * count
          vespene = (cost["vespene"] || 0).to_i * count
          unless world.can_afford?(player_id, minerals, vespene)
            result.reject!(index, "insufficient_resources", "not enough resources for #{count} x #{unit_type}")
            next result
          end

          supply = (cost["supply"] || 0).to_i * count
          st = world.state(player_id)
          if supply.positive? && (st[:supply_used] + st[:supply_pending] + supply) > st[:supply_max]
            result.reject!(index, "insufficient_resources", "supply cap would be exceeded")
            next result
          end

          world.spend(player_id, minerals, vespene)
          st[:supply_pending] += supply
          count.times { building.train_queue << unit_type }
          result.accept!
        end

        register("build") do |world, player_id, cmd, index, result|
          worker = resolve_one(world, player_id, cmd, "worker_id", index, result) or next result
          unless worker.unit? && worker.worker?
            result.reject!(index, "invalid_payload", "entity #{worker.id} is not a worker")
            next result
          end
          if worker.construct_id.positive?
            result.reject!(index, "production_busy", "worker #{worker.id} is already building")
            next result
          end

          unit_type = value(cmd, "unit_type")
          defn = unit_type.is_a?(String) ? Starc::GameData.building(unit_type) : nil
          if defn.nil? || Starc::GameData.race_of(unit_type) != world.player_race(player_id)
            result.reject!(index, "no_such_unit_type", "no #{unit_type.inspect} in your roster")
            next result
          end

          missing = missing_requirements(world, player_id, defn)
          unless missing.empty?
            result.reject!(index, "not_ready", "requires #{missing.join(', ')}")
            next result
          end

          dest = destination(world, cmd, index, result) or next result
          x, z = dest
          if worker.distance_to_point(x, z) > BUILD_REACH
            result.reject!(index, "out_of_range", "build site is out of reach")
            next result
          end
          unless world.terrain.passable?(x, z)
            result.reject!(index, "out_of_range", "build site is impassable")
            next result
          end

          cost = defn["cost"] || {}
          unless world.can_afford?(player_id, (cost["minerals"] || 0).to_i, (cost["vespene"] || 0).to_i)
            result.reject!(index, "insufficient_resources", "not enough resources for #{unit_type}")
            next result
          end

          world.spend(player_id, (cost["minerals"] || 0).to_i, (cost["vespene"] || 0).to_i)
          building = world.spawn_entity(unit_type, player_id, x, z, build_progress: 0.0, state: "building")
          # A worker that was mining keeps its harvest order and goes back to
          # it when the building is up; anyone else simply stops where they
          # are. Either way the construction site is what it walks to, because
          # `construct_id` outranks the order in the movement phase.
          resuming_harvest = worker.order == ORDER_HARVEST
          worker.construct_id = building.id
          worker.order_queue.clear
          worker.order = resuming_harvest ? ORDER_HARVEST : ORDER_NONE
          worker.target_id = 0
          worker.state = "building"
          worker.hold_position = false
          worker.harvest_phase = :to_node if resuming_harvest
          result.accept!
        end

        register("cancel") do |world, player_id, cmd, index, result|
          building = resolve_one(world, player_id, cmd, "building_id", index, result) or next result
          unless building.is_building
            result.reject!(index, "invalid_payload", "entity #{building.id} is not a building")
            next result
          end
          if building.complete?
            result.reject!(index, "invalid_payload", "building #{building.id} is already complete")
            next result
          end
          building.train_queue.clear
          building.train_key = nil
          building.train_progress = nil
          world.mark_dead(building)
          result.accept!
        end

        register("rally") do |world, player_id, cmd, index, result|
          building = resolve_one(world, player_id, cmd, "building_id", index, result) or next result
          unless building.is_building
            result.reject!(index, "invalid_payload", "entity #{building.id} is not a building")
            next result
          end
          dest = destination(world, cmd, index, result) or next result
          building.rally_x, building.rally_z = dest
          result.accept!
        end

        register("harvest") do |world, player_id, cmd, index, result|
          worker = resolve_one(world, player_id, cmd, "worker_id", index, result) or next result
          unless worker.worker?
            result.reject!(index, "invalid_payload", "entity #{worker.id} cannot harvest")
            next result
          end
          if worker.construct_id.positive?
            result.reject!(index, "production_busy", "worker #{worker.id} is building")
            next result
          end
          worker.order_queue.clear
          worker.order = ORDER_HARVEST
          worker.harvest_phase = :to_node
          worker.hold_position = false
          worker.state = "harvesting"
          result.accept!
        end

        register("ability") do |world, player_id, cmd, index, result|
          entities = resolve_ids(world, player_id, cmd, index, result) or next result
          key = value(cmd, "ability")
          unless key.is_a?(String) && world.registry.key?(key)
            result.reject!(index, "no_such_ability", "no ability #{key.inspect}")
            next result
          end
          failure = nil
          entities.each do |e|
            code = Starc::Sim::Systems::Abilities.cast(world, e, key)
            next if code.nil?

            failure = [e, code]
            break
          end
          if failure
            result.reject!(index, failure[1], "#{key} on entity #{failure[0].id}: #{failure[1]}")
            next result
          end
          result.accept!
        end

        # Selection is advisory and client-side: the server validates the ids
        # so ownership and liveness still hold, but keeps no selection state.
        register("select") do |world, player_id, cmd, index, result|
          resolve_ids(world, player_id, cmd, index, result) or next result
          result.accept!
        end

        register("chat") do |world, player_id, cmd, index, result|
          text = value(cmd, "text")
          unless text.is_a?(String) && !text.empty? && text.length <= MAX_CHAT_LENGTH
            result.reject!(index, "invalid_payload", "text must be 1..#{MAX_CHAT_LENGTH} characters")
            next result
          end
          result.accept!
        end
      end
    end
  end
end
