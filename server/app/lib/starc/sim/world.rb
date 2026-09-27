# frozen_string_literal: true

module Starc
  module Sim
    # The authoritative match simulation.
    #
    # == Determinism
    #
    # Same `seed` + `map_id` + `players` + the same ordered command stream
    # gives byte-identical snapshots. Nothing here may consult the wall clock,
    # a global RNG, or unordered iteration. Entity ids come from one
    # monotonically increasing counter starting at 1 per match
    # (PROTOCOL.md §6) and every float is accumulated in a fixed order.
    #
    # == Step order
    #
    # `step!` runs these phases, always in this order. Each one is a separate
    # module under `Starc::Sim::Systems`, and the order is load-bearing:
    #
    #   1. command application      `Systems::Commands`     — see note below
    #   2. building construction    `Systems::Construction` — build_progress ramps, `built` at 100%
    #   3. production queues        `Systems::Production`   — train_progress, unit spawn
    #   4. harvesting / economy     `Systems::Economy`      — shuttle, mine, deposit, vespene
    #   5. ability effects          `Systems::Abilities`    — buff expiry, ticking damage/heal/shield
    #   6. target acquisition       `Systems::Targeting`    — nearest enemy via the spatial index
    #   7. movement                 `Systems::Movement`     — steering, terrain clamp, separation
    #   8. weapon fire              `Systems::Combat`       — shots, melee/beam, projectiles
    #   9. damage resolution        `Systems::Damage`       — shield absorb, deaths, counters
    #  10. supply / resource acct.  `Systems::Accounting`   — supply, supply cap, z, army value
    #  11. victory check           `Systems::Victory`      — annihilation, timeout, forfeit
    #  12. event drain             `Systems::Events`       — events become readable by the channel
    #
    # Phase 1 deserves a note. Commands arrive between ticks, and
    # `apply_commands` validates and applies each one immediately, because
    # the caller needs the per-command accept/reject result synchronously. No
    # simulation state changes in between, so applying on receipt is exactly
    # equivalent to applying as the first phase of the next tick — there is
    # nothing to defer. `Systems::Commands.step` is therefore a deliberate
    # no-op that keeps the phase list and the code in one-to-one
    # correspondence.
    class World
      PROTOCOL_VERSION = 1
      MESSAGE_TYPE = "game:snapshot"

      TIMEOUT_REASON = "timeout"
      ANNIHILATION_REASON = "annihilation"
      FORFEIT_REASON = "forfeit"
      STALEMATE_REASON = "stalemate"

      # 90 minutes of sim time at 20 Hz.
      MATCH_TIMEOUT_TICKS = 108_000

      # A shot with no explicit speed still has to travel at something sane.
      DEFAULT_PROJECTILE_SPEED = 40.0
      # Splash falloff for weapons that declare only a radius.
      DEFAULT_SPLASH_DAMAGE_PCT = 0.5

      # Shields only start recharging once a unit has been out of combat.
      SHIELD_REGEN_DELAY_S = 5.0
      SHIELD_REGEN_INTERVAL_TICKS = 20

      # Openings: 4..6 workers, drawn deterministically from the player stream.
      MIN_STARTING_WORKERS = 4
      STARTING_WORKERS_VARIANCE = 3
      STARTING_WORKER_RING = 3.5
      NODE_RING_RADIUS = 2.5

      # Resource node yields. Maps declare only cluster positions and counts,
      # so the per-node amount is a simulation constant, not a roster stat.
      RICH_NODE_AMOUNT = 1200.0
      NORMAL_NODE_AMOUNT = 700.0
      # Re-pick a node once the cached one is further away than this.
      NODE_REACQUIRE_DISTANCE_SQ = 64.0 * 64.0

      # A mineral node. Deliberately not an entity: it is not a roster unit, it
      # has no combat, and it must never appear in a snapshot.
      Node = Struct.new(:id, :x, :y, :amount, :rich)

      attr_reader :seed, :map_id, :map, :terrain, :index, :tick, :players,
                  :registry, :projectiles, :nodes, :effects, :finished,
                  :ack_tick, :size, :events

      def initialize(seed:, map_id:, players:)
        @seed = seed.to_i
        @map_id = map_id.to_s
        @map = Starc::Maps.find(@map_id) or
          raise ArgumentError, "unknown map_id #{map_id.inspect}"
        @terrain = Starc::Sim::Terrain.for(@map_id)
        @size = @terrain.size
        @registry = Starc::Sim::BuffRegistry.build

        @players = normalize_players(players)
        @player_state = {}
        @players.each { |p| @player_state[p[:id]] = new_player_state(p) }

        @tick = 0
        @ack_tick = 0
        @next_entity_id = 1
        @next_projectile_id = 1
        @next_node_id = 1
        @rngs = {}

        @entities = {}   # id => Entity, living and dead
        @living = []     # living entities in creation order
        @index = Starc::Sim::SpatialIndex.new
        @projectiles = []
        @nodes = []
        @node_index = {}
        @node_cache = {}
        @effects = []
        @events = []
        @pending_deaths = []
        @weapon_cache = {}

        @dt = tick_ms / 1000.0
        @ticks_per_second = 1000.0 / tick_ms
        @shield_recharge_delay_ticks = (SHIELD_REGEN_DELAY_S * @ticks_per_second).ceil

        setup_opening!
      end

      # --- clock ------------------------------------------------------------

      def tick_ms
        Starc::GameData.tick_ms
      end

      # Fixed simulation step in seconds. 50 ms at 20 Hz.
      attr_reader :dt

      def ticks_per_second
        @ticks_per_second
      end

      def elapsed_ms
        @tick * tick_ms
      end

      # --- stepping ---------------------------------------------------------

      # Advance exactly one 50 ms tick. Once the match has ended this is a
      # no-op, so a channel can keep pumping without special-casing the end.
      def step!
        return @tick if @finished

        Systems::Commands.step(self, @dt)
        Systems::Construction.step(self, @dt)
        Systems::Production.step(self, @dt)
        Systems::Economy.step(self, @dt)
        Systems::Abilities.step(self, @dt)
        Systems::Targeting.step(self, @dt)
        Systems::Movement.step(self, @dt)
        Systems::Combat.step(self, @dt)
        Systems::Damage.step(self, @dt)
        Systems::Accounting.step(self, @dt)
        Systems::Victory.step(self, @dt)
        Systems::Events.step(self, @dt)

        @tick += 1
        @tick
      end

      def finished?
        @finished
      end

      def over?
        !@finished.nil?
      end

      def timeout?
        @tick >= MATCH_TIMEOUT_TICKS
      end

      # A player giving up: they lose and the match ends immediately.
      def forfeit(player_id, reason = FORFEIT_REASON)
        return @finished if @finished

        winner = @players.find { |p| p[:id] != player_id }&.fetch(:id)
        @finished = { winner: winner, reason: reason, tick: @tick }
      end

      # End the match outright (annihilation, timeout, stalemate).
      def finish!(winner, reason)
        return @finished if @finished

        @finished = { winner: winner, reason: reason, tick: @tick }
      end

      # --- commands ---------------------------------------------------------

      # Validate and apply a whole `game:command` batch for one player. Bad
      # commands are dropped individually; the good ones still land. See
      # `Starc::Sim::Systems::Commands` for the per-command rules.
      def apply_commands(player_id, commands)
        result = Systems::Commands.apply(self, player_id, commands)
        @ack_tick = @tick if result.applied.positive?
        result
      end

      # --- lookups ----------------------------------------------------------

      def entity(id)
        @entities[id]
      end

      def alive_entity(id)
        e = @entities[id]
        e if e&.alive?
      end

      def living
        @living
      end

      def living_count
        @living.size
      end

      def each_living(&block)
        @living.each(&block)
      end

      def player_ids
        @players.map { |p| p[:id] }
      end

      def player(id)
        @players.find { |p| p[:id] == id }
      end

      def player_race(id)
        player(id)&.fetch(:race)
      end

      def state(id)
        @player_state[id]
      end

      def states
        @player_state
      end

      def allies?(a, b)
        return false if a.nil? || b.nil? || a == b

        pa = player(a)
        pb = player(b)
        !pa.nil? && !pb.nil? && pa[:team] == pb[:team]
      end

      def enemies?(a, b)
        return false if a.nil? || b.nil? || a == b

        !allies?(a, b)
      end

      def state_of(entity)
        @player_state[entity.player_id]
      end

      # Public player accounting, in exactly the shape the channel and the
      # end-of-match scores read.
      def player_states
        out = {}
        @players.each do |p|
          st = @player_state[p[:id]]
          out[p[:id]] = {
            minerals: st[:minerals].to_i,
            vespene: st[:vespene].to_i,
            supply: st[:supply_used].to_i,
            supply_max: st[:supply_max].to_i,
            kills: st[:kills].to_i,
            deaths: st[:deaths].to_i,
            resources_mined: st[:resources_mined].to_i,
            units_built: st[:units_built].to_i,
            army_value: st[:army_value].to_i,
            alive: st[:alive]
          }
        end
        out
      end

      # Every entity the match has ever produced, in id order. Used for the
      # replay's `final_state`; the dead carry `st: "dead"`.
      def entities
        @entities.values.sort_by(&:id)
      end

      def entity_states
        entities.map(&:to_state_hash)
      end

      # --- random streams ---------------------------------------------------

      # One mulberry32 stream per player, seeded exactly as PROTOCOL.md §6
      # prescribes. Stream 0 is the neutral/world stream.
      def rng(player_id)
        @rngs[player_id] ||=
          Starc::Sim::Rng.new(Starc::Sim::Rng.stream_seed(@seed, player_id.to_i))
      end

      # --- events -----------------------------------------------------------

      def emit(event)
        @events << event
        event
      end

      def pending_events
        @events
      end

      # Events are transient and live for exactly one snapshot. `snapshot`
      # drains them, so a caller that only reads snapshots never sees an
      # event twice and never drops one.
      def drain_events
        out = @events
        @events = []
        out
      end

      # --- snapshot ---------------------------------------------------------

      # PROTOCOL.md §5 `game:snapshot`, ready to broadcast: the envelope is
      # included so the channel can hand this straight to ActionCable. Pass
      # `server_ms:` to stamp a real epoch `ts`; without it `ts` falls back to
      # the simulation clock, which keeps replays and determinism tests free
      # of wall-clock time.
      def snapshot(server_ms: nil)
        {
          "v" => PROTOCOL_VERSION,
          "t" => MESSAGE_TYPE,
          "ts" => server_ms || elapsed_ms,
          "tick" => @tick,
          "server_ms" => @tick * tick_ms,
          "ack" => @ack_tick,
          "entities" => snapshot_entities,
          "events" => drain_events
        }
      end

      def snapshot_entities
        tick = @tick
        out = Array.new(@living.size)
        i = 0
        while i < @living.size
          out[i] = @living[i].to_snapshot_hash(tick: tick)
          i += 1
        end
        out
      end

      # Per-viewer snapshot. `sel` is advisory colour state — 0 none, 1 self,
      # 2 ally, 3 enemy — and is the one field the broadcast leaves out.
      def snapshot_for(player_id, server_ms: nil)
        base = snapshot(server_ms: server_ms)
        tick = @tick
        base["entities"] = @living.map do |e|
          e.to_snapshot_hash(selected_for: selection_for(e, player_id), tick: tick)
        end
        base
      end

      def selection_for(entity, viewer_id)
        return 0 if entity.player_id == viewer_id

        allies?(entity.player_id, viewer_id) ? 2 : 3
      end

      # --- spawning ---------------------------------------------------------

      def next_entity_id
        @next_entity_id.tap { @next_entity_id += 1 }
      end

      def next_projectile_id
        @next_projectile_id.tap { @next_projectile_id += 1 }
      end

      def next_node_id
        @next_node_id.tap { @next_node_id += 1 }
      end

      # Create an entity. `build_progress` of 1.0 means it exists complete;
      # anything lower puts it under construction, with its supply already
      # reserved from the moment the build was accepted.
      def spawn_entity(type_key, player_id, x, z, build_progress: 1.0, state: nil, order: nil)
        defn = Starc::GameData.unit(type_key) || Starc::GameData.building(type_key)
        return nil unless defn

        cx, cz = @terrain.clamp_to_world(x, z)
        e = Starc::Sim::Entity.new(
          id: next_entity_id, type_key: type_key, player_id: player_id,
          x: cx, z: cz, defn: defn, registry: @registry
        )
        e.created_tick = @tick
        e.build_progress = [[build_progress, 0.0].max, 1.0].min
        e.z_world = height_for(e)
        e.state = state if state
        e.order = order if order
        @entities[e.id] = e
        @living << e
        @index.insert(e)
        note_unit_built(player_id) if e.unit?
        e
      end

      def height_for(entity)
        entity.is_air ? Starc::Sim::Terrain::AIR_ALTITUDE : @terrain.height_at(entity.x, entity.z)
      end

      # Flag an entity dead. The death event, kill/death counters and
      # reference cleanup all happen in phase 9.
      def mark_dead(entity)
        return false if entity.dead

        entity.dead = true
        entity.hp = 0.0
        entity.state = "dead"
        @index.remove(entity.id)
        @pending_deaths << entity
        true
      end

      def pending_deaths
        @pending_deaths
      end

      # Rebuild the living list after deaths. No allocation per entity.
      def compact_living!
        @living.reject! { |e| e.dead }
      end

      # --- weapons ----------------------------------------------------------

      # Normalised weapon profile for a unit (`attack`) or a building
      # (`defense`); nil when the entity cannot shoot at all. Cached per type
      # so the roster is walked once, not every tick.
      def weapon_for(entity)
        key = entity.type_key
        cached = @weapon_cache[key]
        return nil if cached == false
        return cached if cached

        profile = build_weapon_profile(key, entity)
        @weapon_cache[key] = profile || false
        profile
      end

      def combat_capable?(entity)
        !weapon_for(entity).nil?
      end

      # Ground units, air units and structures are three separate target
      # classes; a weapon may only hit the ones in its `targets` list.
      def target_class(entity)
        return "air" if entity.is_air

        entity.is_building ? "structure" : "ground"
      end

      def can_hit?(weapon, target)
        return false if weapon.nil? || target.nil?

        weapon["targets"].include?(target_class(target))
      end

      # Nearest live, targetable enemy within `range`, via the spatial index.
      # Cloaked units are invisible; `reveal` overrides that for everyone.
      def find_nearest_enemy(seeker, range, respect_cloak: true, tick: @tick)
        return nil unless range.positive?

        best = nil
        best_d = range * range
        @index.query_radius(seeker.x, seeker.z, range, seeker.id).each do |e|
          next unless e.alive?
          next if e.player_id == seeker.player_id
          next if allies?(e.player_id, seeker.player_id)
          next if respect_cloak && e.cloaked?(tick) && !e.revealed?(tick)

          d = seeker.dist2_to(e)
          next if d > best_d

          best_d = d
          best = e
        end
        best
      end

      # --- damage -----------------------------------------------------------

      # Apply raw damage: shields absorb first, armour soaks the rest, and a
      # minimum of 1 always lands. Death itself is resolved in phase 9.
      def apply_damage(target, amount, source_id: nil, tick: @tick)
        return 0.0 unless target&.alive?

        raw = amount.to_f
        return 0.0 unless raw.positive?

        shield = target.shield
        absorbed = 0.0
        if shield.positive?
          absorbed = shield < raw ? shield : raw
          target.shield = shield - absorbed
        end
        rest = raw - absorbed
        if rest.positive?
          rest -= target.effective_armor(tick)
          rest = 1.0 if rest < 1.0
        end
        target.hp -= rest
        target.hp = 0.0 if target.hp.negative?
        target.last_hit_tick = tick
        target.last_damage_tick = tick
        target.last_hit_by = source_id if source_id
        target.shield_recharge_at_tick = tick + @shield_recharge_delay_ticks
        # Flag the kill the moment HP runs out. The death event, the kill and
        # death counters and the reference cleanup all happen in phase 9; this
        # only stops anything else from shooting a corpse this same tick.
        mark_dead(target) unless target.hp.positive?

        emit(
          "e" => "hit", "id" => source_id || 0, "tid" => target.id,
          "dmg" => (absorbed + rest).round(2), "crit" => false,
          "shield" => absorbed.positive?
        )
        absorbed + rest
      end

      def heal(entity, amount, tick: @tick)
        return 0.0 unless entity&.alive?

        before = entity.hp
        entity.hp += amount
        entity.hp = entity.hp_max if entity.hp > entity.hp_max
        entity.hp - before
      end

      def add_shield(entity, amount)
        return 0.0 unless entity&.alive?

        max = entity.total_shield_max(@tick)
        before = entity.shield
        entity.shield += amount
        entity.shield = max if entity.shield > max
        entity.shield - before
      end

      def shield_recharge_delay_ticks
        @shield_recharge_delay_ticks
      end

      # --- resource nodes ---------------------------------------------------

      def node(id)
        @node_index[id]
      end

      def add_node(x, z, amount, rich: false)
        cx, cz = @terrain.clamp_to_world(x, z)
        n = Node.new(id: next_node_id, x: cx, y: cz, amount: amount.to_f, rich: rich)
        @nodes << n
        @node_index[n.id] = n
        n
      end

      # Nearest node with minerals left. Cached per owner, so a shuttling
      # worker does not rescan the node table every tick; the cache is
      # dropped as soon as the node runs dry.
      def nearest_node(x, z, owner_id = 0)
        cached = @node_cache[owner_id]
        if cached
          n = cached
          if n && n.amount.positive?
            d = ((n.x - x) * (n.x - x)) + ((n.y - z) * (n.y - z))
            return n if d <= NODE_REACQUIRE_DISTANCE_SQ
          end
        end
        best = nil
        best_d = Float::INFINITY
        @nodes.each do |n|
          next unless n.amount.positive?

          d = ((n.x - x) * (n.x - x)) + ((n.y - z) * (n.y - z))
          next if d >= best_d

          best_d = d
          best = n
        end
        @node_cache[owner_id] = best
        best
      end

      # --- resources --------------------------------------------------------

      def can_afford?(player_id, minerals, vespene = 0)
        st = @player_state[player_id]
        !st.nil? && st[:minerals] >= minerals && st[:vespene] >= vespene
      end

      def spend(player_id, minerals, vespene = 0)
        st = @player_state[player_id]
        return false if st.nil?
        return false if st[:minerals] < minerals || st[:vespene] < vespene

        st[:minerals] -= minerals
        st[:vespene] -= vespene
        true
      end

      def gain(player_id, minerals, vespene = 0)
        st = @player_state[player_id]
        return nil if st.nil?

        st[:minerals] += minerals
        st[:vespene] += vespene
        st
      end

      def note_unit_built(player_id)
        st = @player_state[player_id]
        st[:units_built] += 1 if st
      end

      private

      def build_weapon_profile(key, entity)
        if entity.is_building
          defense = entity.defn["defense"]
          return nil unless defense

          {
            "damage" => defense["damage"].to_f,
            "range" => defense["range"].to_f,
            "cooldown" => defense["cooldown"].to_f,
            "weapon" => defense["weapon"] || "cannon",
            "projectile_speed" => DEFAULT_PROJECTILE_SPEED,
            "targets" => defense["targets"] || [],
            "splash" => defense["missile_splash"] ? {
              "radius" => defense["missile_splash"].to_f,
              "damage_pct" => DEFAULT_SPLASH_DAMAGE_PCT
            } : nil
          }
        else
          attack = Starc::GameData.attack(key)
          return nil unless attack && attack["damage"]

          {
            "damage" => attack["damage"].to_f,
            "range" => attack["range"].to_f,
            "cooldown" => attack["cooldown"].to_f,
            "weapon" => attack["weapon"],
            "projectile_speed" => (attack["projectile_speed"] || DEFAULT_PROJECTILE_SPEED).to_f,
            "targets" => attack["targets"] || [],
            "splash" => attack["splash"]
          }
        end
      end

      def normalize_players(players)
        list = Array(players).map do |p|
          h = p.transform_keys(&:to_sym)
          slot = h[:slot].to_i
          {
            id: h[:id].to_i,
            race: h[:race].to_s,
            slot: slot,
            # Free-for-all unless the caller says otherwise; a `team` match
            # passes real teams, and PROTOCOL.md §3's 2-player example has
            # team == slot + 1.
            team: (h[:team] || slot + 1).to_i,
            name: h[:name]
          }
        end
        list.sort_by! { |p| [p[:slot], p[:id]] }
        list
      end

      def new_player_state(p)
        starting = Starc::GameData.starting_resources || {}
        {
          id: p[:id],
          race: p[:race],
          slot: p[:slot],
          team: p[:team],
          minerals: (starting["minerals"] || 0).to_i,
          vespene: (starting["vespene"] || 0).to_i,
          vespene_frac: 0.0,
          supply_used: 0,
          supply_max: Starc::GameData.base_supply,
          supply_pending: 0,
          kills: 0,
          deaths: 0,
          resources_mined: 0,
          units_built: 0,
          army_value: 0,
          alive: true,
          main_building_id: nil
        }
      end

      # The opening world. Every client reconstructs this from seed + map +
      # roster, so it is never transmitted (PROTOCOL.md §3).
      def setup_opening!
        @players.each do |p|
          start = @terrain.start_position(p[:slot])
          hq = spawn_entity(Starc::GameData.starting_building(p[:race]), p[:id], start["x"], start["y"])
          @player_state[p[:id]][:main_building_id] = hq&.id
          seed_mineral_field(p[:id], start)
          place_starting_workers(p[:id], Starc::GameData.starting_unit(p[:race]), start)
        end
      end

      def place_starting_workers(player_id, worker_key, start)
        defn = Starc::GameData.unit(worker_key)
        return unless defn&.dig("harvest")

        rng = rng(player_id)
        count = MIN_STARTING_WORKERS + rng.int(STARTING_WORKERS_VARIANCE)
        base_angle = rng.range(0.0, Math::PI * 2.0)
        count.times do |i|
          angle = base_angle + ((Math::PI * 2.0) * i / count)
          offset = STARTING_WORKER_RING + rng.range(0.0, 1.0)
          w = spawn_entity(worker_key, player_id,
                           start["x"] + (Math.cos(angle) * offset),
                           start["y"] + (Math.sin(angle) * offset))
          next unless w

          w.order = Starc::Sim::Entity::ORDER_HARVEST
          w.state = "harvesting"
          w.harvest_phase = :to_node
        end
      end

      # The nearest declared cluster to the base becomes its starting field.
      # Nodes ring out from the cluster centre so workers fan out instead of
      # stacking on one spot.
      def seed_mineral_field(player_id, start)
        clusters = @terrain.mineral_clusters
        return if clusters.empty?

        best = nil
        best_d = Float::INFINITY
        clusters.each do |c|
          d = ((c["x"] - start["x"])**2) + ((c["y"] - start["y"])**2)
          next if d >= best_d

          best_d = d
          best = c
        end
        return unless best

        amount = best["rich"] ? RICH_NODE_AMOUNT : NORMAL_NODE_AMOUNT
        count = (best["count"] || 1).to_i
        count.times do |i|
          rng = rng(player_id + 1000 + i)
          angle = Math::PI * 2.0 * rng.next_float
          radius = NODE_RING_RADIUS * rng.next_float
          add_node(best["x"] + (Math.cos(angle) * radius),
                   best["y"] + (Math.sin(angle) * radius),
                   amount, rich: !!best["rich"])
        end
      end
    end
  end
end
