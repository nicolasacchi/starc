# frozen_string_literal: true

module Api
  module V1
    # Immutable-per-deploy static data. Both payloads are keyed by a content
    # hash, so a long public cache is safe.
    class GameDataController < BaseController
      CACHE_CONTROL = "public, max-age=3600"

      # GET /api/v1/races
      def races
        body = { races: Starc::GameData.races.map { |race| serialize_race(race) } }
        serve_cached(body)
      end

      # GET /api/v1/maps
      def maps
        body = { maps: Starc::Maps.all.map { |map| serialize_map(map) } }
        serve_cached(body)
      end

      private

      def serve_cached(body)
        etag = %("#{Digest::SHA256.hexdigest(body.to_json)}")
        response.headers["ETag"] = etag
        response.headers["Cache-Control"] = CACHE_CONTROL

        if request.headers["If-None-Match"].to_s.split(/,\s*/).include?(etag)
          head :not_modified
          return
        end

        render_ok(body)
      end

      # `game-data.json` embeds full entity defs inside each race, so they pass
      # through verbatim; only `kind` is backfilled defensively.
      def serialize_race(race)
        {
          race: race["race"],
          label: race["label"],
          color: race["color"],
          units: Array(race["units"]).filter_map { |defn| entity_def(defn, "unit") },
          buildings: Array(race["buildings"]).filter_map { |defn| entity_def(defn, "building") }
        }
      end

      def entity_def(definition, kind)
        return nil unless definition.is_a?(Hash)

        normalized = definition.dup
        normalized["kind"] ||= kind
        normalized
      end

      def serialize_map(map)
        {
          id: map["id"],
          name: map["name"],
          size: map["size"],
          max_players: map["max_players"],
          terrain_seed: map["terrain_seed"],
          water: map["water"],
          elevation: map["elevation"],
          biome: map["biome"],
          description: map["description"],
          start_positions: Array(map["start_positions"]),
          mineral_clusters: Array(map["mineral_clusters"]),
          expansion_candidates: Array(map["expansion_candidates"]),
          lighting: map["lighting"]
        }
      end
    end
  end
end
