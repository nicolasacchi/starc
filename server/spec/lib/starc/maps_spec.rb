# frozen_string_literal: true

require "rails_helper"

RSpec.describe Starc::Maps do
  subject(:maps) { described_class }

  # A player with no minerals within walking range of their base has no economy
  # and no reason to exist in the match; the map designer put the clusters
  # there deliberately and this guards the invariant.
  MAX_MINERAL_DISTANCE = 20.0

  describe "catalogue" do
    it "publishes exactly four maps" do
      expect(maps.all.length).to eq(4)
    end

    it "gives every map a unique id" do
      expect(maps.ids.uniq.length).to eq(maps.ids.length)
    end

    it "gives every map a human-readable name" do
      maps.all.each { |m| expect(m["name"]).to be_a(String).and satisfy { |n| !n.strip.empty? } }
    end

    it "resolves the default map id" do
      expect(maps.exist?(maps.default_map_id)).to be(true)
      expect(maps.find(maps.default_map_id)["id"]).to eq(maps.default_map_id)
    end

    it "does not find an unknown id" do
      expect(maps.find("atlantis")).to be_nil
      expect(maps.exist?("atlantis")).to be(false)
    end

    it "finds maps by symbol as well as string" do
      expect(maps.find(maps.default_map_id.to_sym)).to eq(maps.find(maps.default_map_id))
    end
  end

  describe "per-map geometry" do
    it "keeps every size positive" do
      maps.all.each { |m| expect(m["size"]).to be_positive, "#{m['id']} has a non-positive size" }
    end

    it "keeps every max_players in 2..8" do
      maps.all.each do |m|
        expect(m["max_players"]).to be_between(2, 8), "#{m['id']} supports #{m['max_players']} players"
      end
    end

    it "provides at least as many start positions as players" do
      maps.all.each do |m|
        expect(m["start_positions"].length).to be >= m["max_players"],
                                               "#{m['id']} has fewer start positions than it has player slots"
      end
    end

    it "keeps every start position inside [0, size]" do
      maps.all.each do |m|
        m["start_positions"].each do |p|
          expect(p["x"]).to be_between(0, m["size"]), "#{m['id']} start x out of bounds"
          expect(p["z"]).to be_between(0, m["size"]), "#{m['id']} start z out of bounds"
        end
      end
    end

    it "keeps every mineral cluster inside [0, size]" do
      maps.all.each do |m|
        m["mineral_clusters"].each do |c|
          expect(c["x"]).to be_between(0, m["size"]), "#{m['id']} mineral x out of bounds"
          expect(c["z"]).to be_between(0, m["size"]), "#{m['id']} mineral z out of bounds"
        end
      end
    end

    it "keeps every expansion candidate inside [0, size]" do
      maps.all.each do |m|
        m["expansion_candidates"].each do |c|
          expect(c["x"]).to be_between(0, m["size"]), "#{m['id']} expansion x out of bounds"
          expect(c["z"]).to be_between(0, m["size"]), "#{m['id']} expansion z out of bounds"
        end
      end
    end

    it "gives every start position minerals within 20 m" do
      maps.all.each do |m|
        expect(m["mineral_clusters"]).not_to be_empty
        m["start_positions"].each_with_index do |p, i|
          nearest = m["mineral_clusters"].map { |c| Math.hypot(p["x"] - c["x"], p["z"] - c["z"]) }.min
          expect(nearest).to be <= MAX_MINERAL_DISTANCE,
                                "#{m['id']} start #{i} is #{nearest.round(2)} m from the nearest minerals"
        end
      end
    end

    it "gives every mineral cluster a positive node count" do
      maps.all.each do |m|
        m["mineral_clusters"].each do |c|
          expect(c["count"]).to be_positive, "#{m['id']} has an empty mineral cluster"
        end
      end
    end
  end

  describe "lighting" do
    it "keeps time_of_day in 0..1 so the sun never wraps past midnight" do
      maps.all.each do |m|
        expect(m.dig("lighting", "time_of_day")).to be_between(0, 1), "#{m['id']} time_of_day out of range"
      end
    end

    it "keeps fog_density positive" do
      maps.all.each do |m|
        expect(m.dig("lighting", "fog_density")).to be_positive, "#{m['id']} fog_density must be positive"
      end
    end

    it "gives every map a lighting block with a sun colour" do
      maps.all.each do |m|
        expect(m["lighting"]["sun_color"]).to match(/\A#\h{6}\z/)
      end
    end
  end

  describe "terrain seeds" do
    it "gives every map a distinct terrain seed" do
      seeds = maps.all.map { |m| m["terrain_seed"] }
      expect(seeds.uniq.length).to eq(seeds.length)
    end

    it "gives every map a positive elevation" do
      maps.all.each { |m| expect(m["elevation"]).to be_positive }
    end
  end

  describe "immutability" do
    it "freezes nested lighting values" do
      expect { maps.all.first["lighting"]["fog_density"] = 99 }.to raise_error(FrozenError)
    end

    it "freezes the start position array" do
      expect { maps.all.first["start_positions"] << {} }.to raise_error(FrozenError)
    end
  end

  describe ".reload!" do
    it "reproduces the same catalogue" do
      before_ids = maps.ids
      maps.reload!
      expect(maps.ids).to eq(before_ids)
    end
  end
end
