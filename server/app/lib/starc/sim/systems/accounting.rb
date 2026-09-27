# frozen_string_literal: true

module Starc
  module Sim
    module Systems
      # Phase 10 — supply and resource accounting.
      #
      # One pass over the living list rebuilds every player's supply usage,
      # supply cap, army value and liveness, and refreshes each entity's
      # authoritative Z. This is the one place that walks all entities, and
      # it allocates nothing per entity: four small integer counters keyed by
      # player id, then a single pass of assignments. Target acquisition and
      # splash do *not* do this — they go through the spatial index.
      module Accounting
        def self.step(world, dt)
          tick = world.tick
          used = Hash.new(0)
          provided = Hash.new(0)
          army = Hash.new(0)
          alive = {}

          i = 0
          while i < world.living.size
            e = world.living[i]
            i += 1
            next unless e.alive?

            st = world.state(e.player_id)
            next if st.nil?

            alive[e.player_id] = true
            if e.unit?
              used[e.player_id] += e.supply_cost
              army[e.player_id] += e.cost_value
            end
            # Only a finished building provides supply; a half-built one does
            # not count towards the cap until it is up.
            provided[e.player_id] += e.supply_provided if e.complete?

            e.z_world = world.height_for(e)
            cap = e.total_shield_max(tick)
            e.shield = cap if e.shield > cap
          end

          world.player_ids.each do |pid|
            st = world.state(pid)
            next if st.nil?

            st[:supply_used] = used[pid]
            # The main base's own `supply_provided` IS the base allowance.
            # Adding `base_supply` on top would hand a fresh player 20 supply
            # instead of 10, making every map easier than it was designed to be.
            st[:supply_max] = [provided[pid], Starc::GameData.base_supply].max
            st[:army_value] = army[pid]
            st[:alive] = alive.key?(pid)
          end
        end
      end
    end
  end
end
