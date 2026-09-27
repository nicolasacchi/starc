# frozen_string_literal: true

require "rails_helper"

# The two static, client-bootstrapping endpoints. A client that fetches these
# at page load must get a complete, resolvable, cacheable roster — the game is
# literally unstartable without it.
RSpec.describe "Api::V1 game data", type: :request do
  # client/src/shared/protocol.ts `MapDef`.
  def map_def_keys
    %w[id name size max_players terrain_seed water elevation biome description
       start_positions mineral_clusters expansion_candidates lighting]
  end

  def round_trips?
    JSON.parse(response.body).to_json == response.body
  end

  describe "GET /api/v1/races" do
    it "is public and returns all three races with their full roster" do
      get "/api/v1/races"

      expect(response).to have_http_status(:ok)
      races = json_body["races"]
      expect(races.length).to eq(3)
      expect(races.map { |r| r["race"] }).to match_array(%w[terran zerg protoss])
      races.each do |race|
        expect(race.keys).to match_array(%w[race label color units buildings])
        expect(race["label"]).to be_a(String).and satisfy { |l| !l.empty? }
        expect(race["color"]).to match(/\A#\h{6}\z/)
        expect(race["units"].length).to eq(10)
        expect(race["buildings"].length).to eq(9)
      end
    end

    it "gives every entity a key the sim can resolve back to its race" do
      get "/api/v1/races"

      json_body["races"].each do |race|
        (race["units"] + race["buildings"]).each do |entity|
          expect(entity["key"]).to be_a(String).and satisfy { |k| !k.empty? }
          expect { Starc::GameData.race_of(entity["key"]) }
            .not_to raise_error, "#{entity['key']} is not in the roster index"
          expect(Starc::GameData.race_of(entity["key"])).to eq(race["race"])
          expect(entity["kind"]).to eq(race["units"].include?(entity) ? "unit" : "building")
        end
      end
    end

    it "returns entity defs the simulation agrees with stat for stat" do
      get "/api/v1/races"

      json_body["races"].each do |race|
        race["units"].each do |entity|
          expect(Starc::GameData.unit(entity["key"])).to eq(entity.transform_keys(&:to_s))
        end
        race["buildings"].each do |entity|
          expect(Starc::GameData.building(entity["key"])).to eq(entity)
        end
      end
    end

    it "exposes the ten units and nine buildings each race's sim code expects" do
      get "/api/v1/races"

      by_race = json_body["races"].to_h do |race|
        [race["race"], { units: race["units"].map { |u| u["key"] },
                         buildings: race["buildings"].map { |b| b["key"] } }]
      end

      expect(by_race["terran"][:units]).to eq(%w[scv marine firebat siege_tank thor reaper
                                                  ghost battlecruiser raven medic])
      expect(by_race["zerg"][:units]).to eq(%w[drone zergling hydralisk ultralisk queen roach
                                                lurker infestor corruptor guardian])
      expect(by_race["protoss"][:units]).to eq(%w[probe zealot stalker sentry high_templar
                                                  dark_templar adept archon carrier phoenix])
      %w[terran zerg protoss].each do |race|
        expect(by_race[race][:buildings].length).to eq(9)
        expect(by_race[race][:buildings]).to all(be_a(String))
      end
    end

    it "is byte-identical on a second request and answers 304 for a matching ETag" do
      get "/api/v1/races"
      expect(response).to have_http_status(:ok)
      first_body = response.body
      etag = response.headers["ETag"]
      expect(etag).to be_present
      expect(response.headers["Cache-Control"]).to include("max-age")

      get "/api/v1/races"
      expect(response.headers["ETag"]).to eq(etag)
      expect(response.body).to eq(first_body)

      get "/api/v1/races", headers: { "If-None-Match" => etag }
      expect(response).to have_http_status(:not_modified)
      expect(response.body).to be_empty
    end

    it "ignores a stale ETag and serves the body" do
      get "/api/v1/races", headers: { "If-None-Match" => '"stale-hash"' }

      expect(response).to have_http_status(:ok)
      expect(json_body["races"].length).to eq(3)
    end

    it "emits JSON that survives a parse and re-encode with no NaN or Infinity" do
      get "/api/v1/races"

      expect(response.media_type).to eq("application/json")
      expect { round_trips? }.not_to raise_error
      expect(round_trips?).to be(true)
      expect(response.body).not_to match(/NaN|Infinity/)
    end
  end

  describe "GET /api/v1/maps" do
    it "is public and returns the four maps with the MapDef fields" do
      get "/api/v1/maps"

      expect(response).to have_http_status(:ok)
      maps = json_body["maps"]
      expect(maps.length).to eq(4)
      expect(maps.map { |m| m["id"] }).to eq(Starc::Maps.ids)
      maps.each do |map|
        expect(map.keys).to match_array(map_def_keys)
        expect(map["name"]).to be_a(String).and satisfy { |n| !n.empty? }
        expect(map["size"]).to be_between(64, 1024)
        expect(map["max_players"]).to be_between(2, 8)
        expect(map["terrain_seed"]).to be_a(Integer)
        expect([true, false]).to include(map["water"])
        expect(map["elevation"]).to be > 0
        expect(map["biome"]).to be_a(String).and satisfy { |b| !b.empty? }
        expect(map["description"]).to be_a(String).and satisfy { |d| !d.empty? }
      end
    end

    it "returns the same data the server validates match map_id against" do
      get "/api/v1/maps"

      json_body["maps"].each do |map|
        source = Starc::Maps.find(map["id"])
        expect(source).to be_present
        expect(map).to eq(
          "id" => source["id"], "name" => source["name"], "size" => source["size"],
          "max_players" => source["max_players"], "terrain_seed" => source["terrain_seed"],
          "water" => source["water"], "elevation" => source["elevation"], "biome" => source["biome"],
          "description" => source["description"],
          "start_positions" => source["start_positions"],
          "mineral_clusters" => source["mineral_clusters"],
          "expansion_candidates" => source["expansion_candidates"],
          "lighting" => source["lighting"]
        )
      end
    end

    it "gives every map one start position per player slot, inside its bounds" do
      get "/api/v1/maps"

      json_body["maps"].each do |map|
        expect(map["start_positions"].length).to eq(map["max_players"])
        map["start_positions"].each do |point|
          expect(point.keys).to match_array(%w[x z])
          expect(point["x"]).to be_between(0, map["size"])
          expect(point["z"]).to be_between(0, map["size"])
        end
        expect(map["expansion_candidates"]).not_to be_empty
        map["expansion_candidates"].each do |point|
          expect(point["x"]).to be_between(0, map["size"])
          expect(point["z"]).to be_between(0, map["size"])
        end
      end
    end

    it "gives every mineral cluster coordinates and a yield inside the map" do
      get "/api/v1/maps"

      json_body["maps"].each do |map|
        expect(map["mineral_clusters"]).not_to be_empty
        map["mineral_clusters"].each do |cluster|
          expect(cluster["x"]).to be_between(0, map["size"])
          expect(cluster["z"]).to be_between(0, map["size"])
          expect(cluster["count"]).to be >= 1
          # `rich` marks the high-yield vespene nodes and is optional on the rest.
          expect([true, false, nil]).to include(cluster["rich"])
        end
      end
    end

    it "describes lighting the client shader can read" do
      get "/api/v1/maps"

      json_body["maps"].each do |map|
        expect(map["lighting"].keys).to match_array(%w[time_of_day sun_color fog_density])
        expect(map["lighting"]["time_of_day"]).to be_between(0.0, 1.0)
        expect(map["lighting"]["sun_color"]).to match(/\A#\h{6}\z/)
        expect(map["lighting"]["fog_density"]).to be >= 0
      end
    end

    it "is byte-identical on a second request and answers 304 for a matching ETag" do
      get "/api/v1/maps"
      expect(response).to have_http_status(:ok)
      first_body = response.body
      etag = response.headers["ETag"]
      expect(etag).to be_present

      get "/api/v1/maps"
      expect(response.headers["ETag"]).to eq(etag)
      expect(response.body).to eq(first_body)

      get "/api/v1/maps", headers: { "If-None-Match" => etag }
      expect(response).to have_http_status(:not_modified)
      expect(response.body).to be_empty
    end

    it "serves distinct ETags for races and maps" do
      get "/api/v1/races"
      races_etag = response.headers["ETag"]
      get "/api/v1/maps"
      maps_etag = response.headers["ETag"]

      expect(races_etag).not_to eq(maps_etag)
    end

    it "emits JSON that survives a parse and re-encode with no NaN or Infinity" do
      get "/api/v1/maps"

      expect(response.media_type).to eq("application/json")
      expect { round_trips? }.not_to raise_error
      expect(round_trips?).to be(true)
      expect(response.body).not_to match(/NaN|Infinity/)
    end
  end
end
