# frozen_string_literal: true

require "rails_helper"

# The roster in `shared/game-data.json` is the single source of truth for the
# whole game: the client renders it, the server validates against it, and every
# stat in it is hard-coded in exactly one place. A silent edit there is a
# balance regression nobody reviews, so these specs assert the shape and the
# invariants rather than the individual numbers.
RSpec.describe Starc::GameData do
  subject(:data) { described_class }

  # A "combatant" is anything with a weapon that declares what it can shoot.
  # Workers and buildings have no `targets` list and cannot deal damage.
  COMBATANTS = %w[
    zealot stalker sentry high_templar dark_templar adept archon carrier phoenix
    marine firebat siege_tank thor reaper ghost battlecruiser raven
    drone zergling hydralisk ultralisk queen roach lurker corruptor guardian
  ].freeze

  NON_COMBATANTS = %w[
    probe scv medic
    infestor
    nexus pylon assimilator gateway forge photon_cannon cybernetics_core
    twilight_council robotics_facility
    command_center supply_depot refinery barracks engineering_bay factory starport bunker turret
    hatchery overlord extractor spawning_pool hydralisk_den roach_warren spire lair spine_crawler
  ].freeze

  FLYING = %w[carrier phoenix battlecruiser corruptor guardian].freeze

  AIR_CAPABLE = %w[
    stalker sentry carrier phoenix marine thor ghost battlecruiser raven
    hydralisk queen corruptor
  ].freeze

  describe "roster shape" do
    it "loads exactly three races" do
      expect(data.races.map { |r| r["race"] }).to contain_exactly("protoss", "terran", "zerg")
    end

    it "gives every race exactly ten units and nine buildings" do
      data.races.each do |race|
        expect(race["units"].length).to eq(10), "#{race['race']} unit count"
        expect(race["buildings"].length).to eq(9), "#{race['race']} building count"
      end
    end

    it "indexes 57 entities" do
      expect(data.entities.length).to eq(57)
    end

    it "keeps every entity key unique across all races" do
      keys = data.races.flat_map { |r| Starc::GameData::ENTITY_LISTS.flat_map { |l| Array(r[l]).map { |e| e["key"] } } }
      expect(keys.uniq.length).to eq(keys.length)
    end

    it "resolves race_of for every entity key to the race that owns it" do
      data.races.each do |race|
        Starc::GameData::ENTITY_LISTS.each do |list|
          Array(race[list]).each do |entity|
            expect(data.race_of(entity["key"])).to eq(race["race"]),
                                                "race_of(#{entity['key'].inspect}) should be #{race['race']}"
          end
        end
      end
    end

    it "raises for an unknown key instead of silently returning nil" do
      expect { data.race_of("no_such_unit") }.to raise_error(Starc::GameData::MalformedError)
    end
  end

  describe "#unit / #building kind routing" do
    it "returns units from #unit" do
      COMBATANTS.each { |k| expect(data.unit(k)).to be_a(Hash) }
      NON_COMBATANTS.select { |k| data.entities[k]["kind"] == "unit" }.each do |k|
        expect(data.unit(k)).to be_a(Hash)
      end
    end

    it "returns buildings from #building" do
      NON_COMBATANTS.select { |k| data.entities[k]["kind"] == "building" }.each do |k|
        expect(data.building(k)).to be_a(Hash)
        expect(data.unit(k)).to be_nil, "building #{k} must not be reachable through #unit"
      end
    end

    it "returns nil from both for an unknown key" do
      expect(data.unit("nope")).to be_nil
      expect(data.building("nope")).to be_nil
    end
  end

  describe "#attack" do
    it "returns a full attack block for every combatant" do
      COMBATANTS.each do |key|
        attack = data.attack(key)
        expect(attack).to be_a(Hash), "#{key} should have an attack block"
        expect(attack["targets"]).to be_a(Array), "#{key} should declare targets"
        expect(attack["targets"]).not_to be_empty
        expect(attack).to include("damage", "range", "cooldown", "weapon", "projectile_speed")
        expect(attack["damage"]).to be >= 0
        expect(attack["range"]).to be_positive
        expect(attack["cooldown"]).to be_positive
      end
    end

    it "returns no target list for every non-combatant" do
      NON_COMBATANTS.each do |key|
        expect(data.attack(key)&.fetch("targets", nil)).to be_nil,
                                                   "#{key} must not be able to shoot anything"
        expect(data.attackable?(key)).to be(false), "#{key} must not be attackable"
      end
    end

    it "returns nil for buildings outright" do
      buildings = data.entities.select { |_, e| e["kind"] == "building" }.keys
      expect(buildings).not_to be_empty
      buildings.each { |k| expect(data.attack(k)).to be_nil }
    end

    it "agrees with attackable? on the combatant/non-combatant boundary" do
      mismatches = data.entities.keys.reject { |k| data.attackable?(k) == COMBATANTS.include?(k) }
      expect(mismatches).to be_empty, "attackable? disagrees for #{mismatches.inspect}"
    end
  end

  describe "#is_air?" do
    it "is true for exactly the flying units" do
      flying = data.entities.keys.select { |k| data.is_air?(k) }
      expect(flying).to match_array(FLYING)
    end

    it "is false for every ground and non-mover entity" do
      (data.entities.keys - FLYING).each do |key|
        expect(data.is_air?(key)).to be(false), "#{key} should not be airborne"
      end
    end
  end

  describe "#can_attack_air?" do
    it "agrees with the entity's declared targets for all 57 entities" do
      mismatches = data.entities.keys.reject do |key|
        targets = data.attack(key)&.fetch("targets", nil)
        data.can_attack_air?(key) == (targets.is_a?(Array) && targets.include?("air"))
      end
      expect(mismatches).to be_empty, "can_attack_air? disagrees for #{mismatches.inspect}"
    end

    it "is true for exactly the air-capable combatants" do
      capable = data.entities.keys.select { |k| data.can_attack_air?(k) }
      expect(capable).to match_array(AIR_CAPABLE)
    end
  end

  describe "cross-references" do
    it "resolves every produces reference inside the owning race" do
      data.races.each do |race|
        local = Array(race["units"]) + Array(race["buildings"])
        by_key = local.each_with_object({}) { |e, h| h[e["key"]] = e }
        local.each do |entity|
          Array(entity["produces"]).each do |target|
            expect(by_key).to have_key(target), "#{race['race']}/#{entity['key']} produces unknown #{target}"
            expect(by_key[target]).to be_a(Hash), "#{target} produced by #{entity['key']} did not resolve"
          end
        end
      end
    end

    it "resolves every required_buildings reference inside the owning race" do
      data.races.each do |race|
        by_key = Array(race["buildings"]).each_with_object({}) { |e, h| h[e["key"]] = e }
        (Array(race["units"]) + Array(race["buildings"])).each do |entity|
          Array(entity["required_buildings"]).each do |req|
            expect(by_key).to have_key(req), "#{race['race']}/#{entity['key']} requires unknown building #{req}"
          end
        end
      end
    end

    it "resolves every ability spawn reference inside the owning race" do
      data.races.each do |race|
        by_key = (Array(race["units"]) + Array(race["buildings"])).each_with_object({}) { |e, h| h[e["key"]] = e }
        (Array(race["units"]) + Array(race["buildings"])).each do |entity|
          data.abilities(entity["key"]).each do |ability|
            next unless ability["spawn"]

            expect(by_key).to have_key(ability["spawn"]),
                             "#{race['race']}/#{entity['key']} ability #{ability['key']} spawns unknown #{ability['spawn']}"
          end
        end
      end
    end
  end

  describe "hotkeys" do
    it "are single characters and unique within a race" do
      data.races.each do |race|
        hotkeys = (Array(race["units"]) + Array(race["buildings"])).map { |e| e["hotkey"] }
        expect(hotkeys).to all(be_a(String))
        expect(hotkeys.map(&:length).uniq).to eq([1]), "#{race['race']} has a multi-character hotkey"
        expect(hotkeys.uniq.length).to eq(hotkeys.length), "#{race['race']} has duplicate hotkeys"
      end
    end
  end

  describe "unit costs and weapons" do
    it "keeps every unit supply cost in 1..3" do
      data.entities.each do |key, entity|
        next unless entity["kind"] == "unit"

        expect(entity["cost"]["supply"]).to be_between(1, 3), "#{key} supply cost out of range"
      end
    end

    it "gives melee and claw weapons no projectile travel" do
      melee = data.entities.select { |_, e| %w[melee claw].include?(e.dig("attack", "weapon")) }
      expect(melee).not_to be_empty
      melee.each do |key, entity|
        expect(entity["attack"]["projectile_speed"]).to eq(0), "#{key} is melee but has a projectile speed"
      end
    end

    it "gives every other weapon a projectile speed in 20..100" do
      ranged = data.entities.select do |_, e|
        e["attack"].is_a?(Hash) && e["attack"].key?("projectile_speed") &&
          !%w[melee claw].include?(e["attack"]["weapon"])
      end
      expect(ranged).not_to be_empty
      ranged.each do |key, entity|
        expect(entity["attack"]["projectile_speed"]).to be_between(20, 100),
                                                          "#{key} projectile speed out of range"
      end
    end
  end

  describe "harvesting" do
    it "has exactly one harvesting unit per race, fully specified" do
      data.races.each do |race|
        harvesters = Array(race["units"]).select { |e| e["harvest"].is_a?(Hash) }
        expect(harvesters.length).to eq(1), "#{race['race']} should have exactly one harvester"
        harvester = harvesters.first
        expect(harvester["harvest"]).to include("capacity", "rate", "refund_pct")
        expect(harvester["harvest"]["capacity"]).to be_positive
        expect(harvester["harvest"]["rate"]).to be_positive
        expect(harvester["harvest"]["refund_pct"]).to be_between(0, 1)
        expect(data.harvest(harvester["key"])).to eq(harvester["harvest"])
      end
    end

    it "returns nil harvest for everything that is not the harvester" do
      (data.entities.keys - %w[probe scv drone]).each do |key|
        expect(data.harvest(key)).to be_nil, "#{key} should not harvest"
      end
    end
  end

  describe "immutability" do
    it "freezes nested entity hashes" do
      expect { data.entities["probe"]["hp"] = 1 }.to raise_error(FrozenError)
    end

    it "freezes nested attack and ability hashes" do
      expect { data.attack("marine")["damage"] = 999 }.to raise_error(FrozenError)
      expect { data.abilities("marine").first["cooldown"] = 0 }.to raise_error(FrozenError)
    end

    it "freezes the ability and produces arrays themselves" do
      expect { data.abilities("marine") << {} }.to raise_error(FrozenError)
      expect { data.building("gateway")["produces"] << "marine" }.to raise_error(FrozenError)
    end

    it "freezes nested cost hashes" do
      expect { data.unit("marine")["cost"]["minerals"] = 0 }.to raise_error(FrozenError)
    end

    it "leaves a reload-able copy intact after a rejected mutation attempt" do
      original = data.unit("marine")["hp"]
      begin
        data.unit("marine")["hp"] = 0
      rescue FrozenError
        nil
      end
      expect(described_class.reload!.fetch("units").fetch("marine").fetch("hp")).to eq(original)
      expect(data.unit("marine")["hp"]).to eq(original)
    end
  end

  describe "global constants" do
    it "locks the simulation tick" do
      expect(data.tick_ms).to eq(50)
    end

    it "locks the world size and supply cap" do
      expect(data.world_size).to eq(256)
      expect(data.max_supply).to eq(200)
    end

    it "names a real starting unit of the right race for every race" do
      data.races.each do |race|
        key = data.starting_unit(race["race"])
        expect(data.race_of(key)).to eq(race["race"])
        expect(data.unit(key)).to be_a(Hash), "starting unit #{key} is not a unit"
      end
    end

    it "names a real starting building of the right race for every race" do
      data.races.each do |race|
        key = data.starting_building(race["race"])
        expect(data.race_of(key)).to eq(race["race"])
        expect(data.building(key)).to be_a(Hash), "starting building #{key} is not a building"
      end
    end

    it "raises when asked for a race that does not exist" do
      expect { data.starting_unit("orc") }.to raise_error(KeyError)
    end
  end

  describe "#races_for_players" do
    it "rotates through the races" do
      expect(data.races_for_players(4)).to eq(%w[protoss terran zerg protoss])
    end

    it "rejects a non-positive or non-integer player count" do
      expect { data.races_for_players(0) }.to raise_error(ArgumentError)
      expect { data.races_for_players(-1) }.to raise_error(ArgumentError)
      expect { data.races_for_players("2") }.to raise_error(ArgumentError)
    end
  end
end
