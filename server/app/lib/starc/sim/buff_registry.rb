# frozen_string_literal: true

module Starc
  module Sim
    # Immutable index of every ability in the shared roster, keyed by ability
    # key.
    #
    # `buffs` on an Entity is just `{ ability_key => expiry_tick }`, so the
    # simulation needs a cheap way to turn a bare ability key into its effect
    # and magnitude. That lookup happens on every modifier read (a few million
    # times a match), which is why it is built once at boot and never
    # mutated — never a Hash scan, never a literal pulled out of thin air.
    class BuffRegistry
      EFFECT_KINDS = %w[
        damage heal shield speed_boost attack_boost armor_boost
        cloak blink web slow reveal spawn
      ].freeze

      # Effects that change movement speed. `speed_boost` is a multiplier
      # (>1), `slow`/`web` is a multiplier (<1); both stack multiplicatively.
      SPEED_EFFECTS = %w[speed_boost slow web].freeze
      # Effects that re-apply damage/heal/shield on a cadence.
      TICKING_EFFECTS = %w[damage heal shield].freeze
      # Effects that are purely passive while their buff is up.
      PASSIVE_EFFECTS = %w[cloak attack_boost armor_boost reveal].freeze
      # Effects applied once, at cast time.
      INSTANT_EFFECTS = %w[blink spawn].freeze

      def self.build
        meta = {}
        Starc::GameData.entities.each_value do |defn|
          (defn["abilities"] || []).each do |ability|
            key = ability["key"]
            next unless key.is_a?(String)
            next if meta.key?(key)

            meta[key] = {
              "key" => key,
              "name" => ability["name"],
              "effect" => ability["effect"],
              "cooldown" => (ability["cooldown"] || 0).to_f,
              "magnitude" => (ability["magnitude"] || 0).to_f,
              "radius" => ability["radius"] && ability["radius"].to_f,
              "target" => ability["target"] || "self",
              "cost" => (ability["cost"] || 0).to_f,
              "spawn" => ability["spawn"],
              "duration" => ability["duration"] && ability["duration"].to_f,
              "duration_s" => ability["duration_s"] && ability["duration_s"].to_f
            }.freeze
          end
        end
        new(meta)
      end

      def initialize(meta)
        @meta = meta.freeze
      end

      def [](key)
        @meta[key]
      end

      def key?(key)
        @meta.key?(key)
      end

      def keys
        @meta.keys
      end

      # Total seconds a cast of this ability keeps the caster on cooldown.
      def cooldown_s(ability_key)
        meta = @meta[ability_key]
        return 0.0 unless meta

        meta["cooldown"].to_f
      end

      # How long the resulting buff lives. `nil` means "until death".
      def duration_s(ability_key)
        meta = @meta[ability_key]
        return nil unless meta

        meta["duration_s"] || meta["duration"]
      end

      def effect(ability_key)
        meta = @meta[ability_key]
        meta && meta["effect"]
      end

      def magnitude(ability_key)
        meta = @meta[ability_key]
        meta ? meta["magnitude"].to_f : 0.0
      end

      def radius(ability_key)
        meta = @meta[ability_key]
        meta && meta["radius"]
      end

      def target(ability_key)
        meta = @meta[ability_key]
        meta ? meta["target"] : "self"
      end

      def cost(ability_key)
        meta = @meta[ability_key]
        meta ? meta["cost"].to_f : 0.0
      end

      def spawn_key(ability_key)
        meta = @meta[ability_key]
        meta && meta["spawn"]
      end

      def ticking?(ability_key)
        TICKING_EFFECTS.include?(effect(ability_key).to_s)
      end

      def speed_effect?(ability_key)
        SPEED_EFFECTS.include?(effect(ability_key).to_s)
      end

      def passive?(ability_key)
        !ticking?(ability_key) && !INSTANT_EFFECTS.include?(effect(ability_key).to_s)
      end

      def instant?(ability_key)
        INSTANT_EFFECTS.include?(effect(ability_key).to_s)
      end
    end
  end
end
