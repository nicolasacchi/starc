# frozen_string_literal: true

module Starc
  # Memoized loader for `shared/game-data.json` — the single source of truth
  # for every unit/building stat. Nothing here hard-codes a number that lives
  # in the roster.
  module GameData
    class MalformedError < StandardError; end

    ENTITY_LISTS = %w[units buildings].freeze

    class << self
      def entities
        data["units"]
      end

      def unit(key)
        def_for(key, "unit")
      end

      def building(key)
        def_for(key, "building")
      end

      # Attack stats, or nil for non-combatants.
      def attack(key)
        def_for(key)&.fetch("attack", nil)
      end

      def harvest(key)
        def_for(key)&.fetch("harvest", nil)
      end

      def abilities(key)
        def_for(key)&.fetch("abilities", nil) || []
      end

      def races
        data["races"]
      end

      def race(race)
        races.find { |r| r["race"] == race.to_s }
      end

      def race_of(key)
        race_index[key] || raise(MalformedError, "unknown entity key #{key.inspect}")
      end

      def tick_ms
        data.fetch("tick_ms")
      end

      def world_size
        data.fetch("world_size")
      end

      def base_supply
        data.fetch("base_supply")
      end

      def supply_increment
        data.fetch("supply_increment")
      end

      def max_supply
        data.fetch("max_supply")
      end

      def starting_unit(race)
        data.fetch("starting_units").fetch(race.to_s)
      end

      def starting_building(race)
        data.fetch("starting_buildings").fetch(race.to_s)
      end

      def starting_resources
        data.fetch("starting_resources")
      end

      def is_air?(key)
        def_for(key)&.fetch("movement", nil) == "air"
      end

      def data
        @data ||= load!
      end

      def reload!
        @data = nil
        @race_index = nil
        data
      end

      private

      def race_index
        @race_index ||= begin
          index = {}
          races.each do |r|
            ENTITY_LISTS.each do |list|
              Array(r[list]).each { |defn| index[defn["key"]] = r["race"] }
            end
          end
          index.freeze
        end
      end

      def def_for(key, kind = nil)
        defn = key && entities[key.to_s]
        return nil unless defn
        return nil if kind && defn["kind"] != kind

        defn
      end

      def load!
        path = Rails.root.join("..", "shared", "game-data.json")
        raise MalformedError, "game data not found at #{path}" unless File.exist?(path)

        parsed = JSON.parse(File.read(path))
        raise MalformedError, "game data is not an object" unless parsed.is_a?(Hash)

        %w[version tick_ms world_size max_supply base_supply supply_increment
           starting_resources starting_units starting_buildings races units].each do |key|
          raise MalformedError, "game data missing #{key}" unless parsed.key?(key)
        end
        raise MalformedError, "game data races must be an array" unless parsed["races"].is_a?(Array)
        raise MalformedError, "game data units must be an object" unless parsed["units"].is_a?(Hash)

        parsed["entities"] = parsed["units"]
        deep_freeze(parsed)
      rescue JSON::ParserError => e
        raise MalformedError, "game data is not valid JSON: #{e.message}"
      end

      def deep_freeze(obj)
        case obj
        when Hash
          obj.each { |k, v| deep_freeze(v) }
          obj.freeze
        when Array
          obj.each { |v| deep_freeze(v) }
          obj.freeze
        else
          obj.freeze
        end
      end
    end
  end
end
