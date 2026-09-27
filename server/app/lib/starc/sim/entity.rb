# frozen_string_literal: true

module Starc
  module Sim
    # One simulated thing on the map: a unit or a building.
    #
    # Plain mutable record (not a Struct) because the simulation touches these
    # hundreds of thousands of times a second; the accessors are the whole
    # interface. Everything that describes the *kind* of thing is read from
    # Starc::GameData at spawn time — no unit stat is ever a literal here.
    class Entity
      # Order kinds, per PROTOCOL.md §5 (`ord`).
      ORDER_NONE = 0
      ORDER_MOVE = 1
      ORDER_ATTACK = 2
      ORDER_HARVEST = 3
      ORDER_PATROL = 4

      # Entity states, per PROTOCOL.md §5 (`st`).
      STATES = %w[
        idle moving attacking harvesting returning building training casting dead
      ].freeze

      # Buildings that refine vespene once complete (Systems::Economy).
      GEYSER_KEYS = %w[refinery extractor assimilator].freeze

      # Stable bit order for the snapshot's `b` buff bitmask. This is wire
      # format: append only, never reorder.
      BUFF_BIT_ORDER = %w[
        cloak speed_boost attack_boost armor_boost shield slow web reveal
      ].freeze
      BUFF_BITS = BUFF_BIT_ORDER.each_with_index.to_h.freeze

      attr_accessor :id, :type_key, :player_id, :x, :z, :hp, :hp_max, :shield, :shield_max,
                    :angle, :state, :target_id, :order, :order_x, :order_z, :patrol_x2, :patrol_z2,
                    :order_queue, :cooldown, :build_progress, :train_progress, :train_queue,
                    :cargo, :rally_x, :rally_z, :is_air, :radius, :height, :speed, :abilities_cooldown,
                    :buffs, :dead, :created_tick, :last_hit_tick

      # Supporting state the wire format does not carry. Still part of the
      # public surface: systems read and write these directly.
      attr_accessor :is_building, :armor, :base_speed, :sight, :build_time, :abilities,
                    :harvest, :cost, :defn, :construct_id, :hold_position, :train_key,
                    :train_serial, :harvest_phase, :harvest_node_id, :last_damage_tick,
                    :summon_expires_tick, :z_world, :shield_recharge_at_tick,
                    :shield_regen, :last_hit_by

      def initialize(id:, type_key:, player_id:, x:, z:, defn:, registry:)
        @id = id
        @type_key = type_key
        @player_id = player_id
        @x = x
        @z = z

        @defn = defn
        @registry = registry
        @is_building = defn["kind"] == "building"
        @hp_max = defn["hp"].to_f
        @hp = @hp_max
        @shield_max = (defn["shield"] || 0).to_f
        @shield = @shield_max
        # Shields per second, read from the roster rather than hard-coded.
        @shield_regen = (defn["shield_regen"] || 0).to_f
        @shield_recharge_at_tick = 0
        @armor = (defn["armor"] || 0).to_f
        @base_speed = (defn["speed"] || 0).to_f
        @speed = @base_speed
        @sight = (defn["sight"] || 0).to_f
        @build_time = [(defn["build_time"] || 1).to_f, 0.05].max
        @radius = (defn["size"] || {}).fetch("radius", 0.5).to_f
        @height = (defn["size"] || {}).fetch("height", 1.0).to_f
        @is_air = Starc::GameData.is_air?(type_key)
        @abilities = Starc::GameData.abilities(type_key)
        @harvest = Starc::GameData.harvest(type_key)
        @cost = defn["cost"] || { "minerals" => 0, "vespene" => 0, "supply" => 0 }

        @angle = 0.0
        @state = "idle"
        @target_id = 0
        @order = ORDER_NONE
        @order_x = x
        @order_z = z
        @patrol_x2 = x
        @patrol_z2 = z
        @order_queue = []
        @cooldown = 0.0
        @build_progress = 1.0
        @train_progress = nil
        @train_queue = []
        @train_key = nil
        @train_serial = 0
        @cargo = 0
        @rally_x = nil
        @rally_z = nil
        @abilities_cooldown = {}
        @buffs = {}
        @dead = false
        @created_tick = 0
        @last_hit_tick = -1_000_000
        @last_hit_by = nil
        @last_damage_tick = -1_000_000

        @construct_id = 0
        @hold_position = false
        @harvest_phase = :none
        @harvest_node_id = nil
        @summon_expires_tick = nil
        @z_world = 0.0
      end

      def registry
        @registry
      end

      def alive?
        !@dead
      end

      def complete?
        @build_progress >= 1.0
      end

      def unit?
        !@is_building
      end

      def worker?
        !@harvest.nil?
      end

      def geyser?
        @is_building && GEYSER_KEYS.include?(@type_key)
      end

      def dist_to(other)
        dx = other.x - @x
        dz = other.z - @z
        Math.sqrt((dx * dx) + (dz * dz))
      end

      def dist2_to(other)
        dx = other.x - @x
        dz = other.z - @z
        (dx * dx) + (dz * dz)
      end

      def distance_to_point(x, z)
        dx = x - @x
        dz = z - @z
        Math.sqrt((dx * dx) + (dz * dz))
      end

      def in_range_of?(other, range)
        return true if range.negative?

        dist2_to(other) <= range * range
      end

      # --- derived combat / movement values --------------------------------

      # Damage is the weapon's own value plus every live `attack_boost`.
      def attack_bonus(tick)
        bonus = 0.0
        each_active_buff(tick) { |key, _expiry| bonus += @registry.magnitude(key) if @registry.effect(key) == "attack_boost" }
        bonus
      end

      def armor_bonus(tick)
        bonus = 0.0
        each_active_buff(tick) { |key, _expiry| bonus += @registry.magnitude(key) if @registry.effect(key) == "armor_boost" }
        bonus
      end

      def effective_armor(tick)
        @armor + armor_bonus(tick)
      end

      # `speed_boost` multiplies above 1, `slow`/`web` below 1; both stack
      # multiplicatively and expire with their buff.
      def speed_multiplier(tick)
        multiplier = 1.0
        each_active_buff(tick) do |key, _expiry|
          case @registry.effect(key)
          when "speed_boost" then multiplier *= (1.0 + @registry.magnitude(key))
          when "slow", "web" then multiplier *= @registry.magnitude(key)
          end
        end
        multiplier.negative? ? 0.0 : multiplier
      end

      def shield_bonus(tick)
        bonus = 0.0
        each_active_buff(tick) { |key, _expiry| bonus += @registry.magnitude(key) if @registry.effect(key) == "shield" }
        bonus
      end

      def total_shield_max(tick)
        @shield_max + shield_bonus(tick)
      end
      def cloaked?(tick)
        each_active_buff(tick) { |key, _expiry| return true if @registry.effect(key) == "cloak" }
        false
      end

      def revealed?(tick)
        each_active_buff(tick) { |key, _expiry| return true if @registry.effect(key) == "reveal" }
        false
      end

      MAX_ORDER_QUEUE = 32

      # Yield every buff whose expiry is still in the future. `tick` of nil
      # means "ignore expiry", which is what the replay's full-state dump
      # wants.
      def each_active_buff(tick)
        return if @buffs.empty?

        if tick
          @buffs.each { |key, expiry| yield(key, expiry) if expiry > tick }
        else
          @buffs.each { |key, expiry| yield(key, expiry) }
        end
      end

      def buff_active?(key, tick)
        expiry = @buffs[key]
        !expiry.nil? && expiry > tick
      end

      def apply_buff(key, expiry_tick)
        @buffs[key] = expiry_tick
      end

      def clear_buff!(key)
        @buffs.delete(key)
      end

      def expire_buffs!(tick)
        return if @buffs.empty?

        @buffs.delete_if { |_key, expiry| expiry <= tick }
      end

      def buff_active_any?(tick)
        tick ? @buffs.any? { |_key, expiry| expiry > tick } : !@buffs.empty?
      end

      # --- orders -----------------------------------------------------------

      def ordered?
        @order != ORDER_NONE || @construct_id != 0
      end

      def clear_orders!
        @order = ORDER_NONE
        @order_queue = []
        @target_id = 0
        @construct_id = 0
        @hold_position = false
        @patrol_x2 = @x
        @patrol_z2 = @z
        @state = "idle" unless @is_building
      end

      def queue_order!(order)
        return if @order_queue.size >= MAX_ORDER_QUEUE

        @order_queue << order
      end

      def harvest_capacity
        @harvest ? @harvest["capacity"].to_i : 0
      end

      def harvest_rate
        @harvest ? @harvest["rate"].to_f : 0.0
      end

      # --- costs ------------------------------------------------------------

      def supply_cost
        @cost.fetch("supply", 0).to_i
      end

      def supply_provided
        @cost.fetch("supply_provided", 0).to_i
      end

      def cost_minerals
        @cost.fetch("minerals", 0).to_i
      end

      def cost_vespene
        @cost.fetch("vespene", 0).to_i
      end

      def cost_value
        cost_minerals + cost_vespene
      end

      def produce?(unit_type)
        (defn["produces"] || []).include?(unit_type)
      end

      def ability(key)
        return nil if @abilities.nil?

        @abilities.find { |a| a["key"] == key }
      end

      def on_cooldown?(key, tick)
        expiry = @abilities_cooldown[key]
        !expiry.nil? && expiry > tick
      end

      def set_cooldown!(key, seconds, tick, tick_per_second)
        ticks = (seconds * tick_per_second).ceil
        @abilities_cooldown[key] = tick + ticks
      end

      # --- wire format ------------------------------------------------------

      # PROTOCOL.md §5 "Entity". Fields equal to the type's static default are
      # omitted so frames stay small; `z` is the authoritative terrain height
      # and is never recomputed client-side.
      #
      # `selected_for` is the advisory colour state: 0 none, 1 self, 2 ally,
      # 3 enemy. The broadcast snapshot omits it (0).
      def to_snapshot_hash(selected_for: 0, tick: nil)
        dead = @dead
        h = {
          "id" => @id,
          "ty" => @type_key,
          "pl" => @player_id,
          "x" => round3(@x),
          "y" => round3(@z),
          "z" => round3(@z_world),
          "hp" => dead ? 0 : round2(@hp),
          "hp_max" => round2(@hp_max),
          "mp" => round2(@shield),
          "mp_max" => round2(total_shield_max(tick)),
          "ang" => round4(@angle),
          "st" => dead ? "dead" : @state
        }

        h["w"] = round2(@cooldown) if @cooldown.positive?
        h["sel"] = selected_for.to_i if selected_for && selected_for.to_i != 0
        h["tid"] = @target_id if @target_id && @target_id.positive?
        if @order != ORDER_NONE
          h["ord"] = @order
          h["ox"] = round3(@order_x)
          h["oy"] = round3(@order_z)
        end
        prog = @train_progress
        prog = @build_progress if prog.nil? || prog.zero?
        h["prog"] = round3(prog) if !dead && prog.positive? && prog < 1.0
        h["cargo"] = @cargo if @cargo.positive?
        h["n"] = @train_queue.size unless @train_queue.nil? || @train_queue.empty?
        mask = buff_mask(tick)
        h["b"] = mask unless mask.zero?
        h
      end

      # Full-fidelity record for replays (`final_state`), where nothing is
      # elided and nothing is rounded away.
      def to_state_hash
        {
          "id" => @id, "ty" => @type_key, "pl" => @player_id,
          "x" => @x, "y" => @z, "z" => @z_world,
          "hp" => @hp, "hp_max" => @hp_max,
          "mp" => @shield, "mp_max" => @shield_max,
          "ang" => @angle, "st" => @dead ? "dead" : @state,
          "w" => @cooldown, "tid" => @target_id, "ord" => @order,
          "ox" => @order_x, "oy" => @order_z,
          "patrol_x2" => @patrol_x2, "patrol_z2" => @patrol_z2,
          "prog" => @build_progress, "train_progress" => @train_progress,
          "train_key" => @train_key, "train_queue" => @train_queue.dup,
          "order_queue" => @order_queue.map(&:dup),
          "cargo" => @cargo, "n" => @train_queue.size,
          "dead" => @dead, "created_tick" => @created_tick,
          "last_hit_tick" => @last_hit_tick,
          "abilities_cooldown" => @abilities_cooldown.dup,
          "buffs" => @buffs.dup,
          "construct_id" => @construct_id,
          "harvest_phase" => @harvest_phase.to_s,
          "harvest_node_id" => @harvest_node_id,
          "summon_expires_tick" => @summon_expires_tick
        }
      end

      def buff_mask(tick = nil)
        return 0 if @buffs.empty?

        mask = 0
        each_active_buff(tick) do |key, _expiry|
          bit = BUFF_BITS[@registry.effect(key)]
          mask |= (1 << bit) if bit
        end
        mask
      end

      def to_h
        to_state_hash
      end

      private

      def round2(v)
        (v * 100.0).round / 100.0
      end

      def round3(v)
        (v * 1000.0).round / 1000.0
      end

      def round4(v)
        (v * 10_000.0).round / 10_000.0
      end
    end
  end
end
