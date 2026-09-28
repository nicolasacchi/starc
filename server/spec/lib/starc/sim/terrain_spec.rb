# frozen_string_literal: true

require "rails_helper"

# The start position is the one place the sim hands a ground-plane point out as
# a hash, and `World#setup_opening!` reads it with `start["x"]` / `start["z"]`.
# The ground plane is x/z and height is y everywhere else in the project
# (see CLAUDE.md), so a `y` key here is read back as nil and every player
# spawns at x=0, z=0 instead of the world centre.
RSpec.describe Starc::Sim::Terrain do
  def map_without_start_positions(size: 64)
    { "id" => "spec-blank-slate", "size" => size, "terrain_seed" => 7, "elevation" => 1.0 }
  end

  describe "#start_position with no declared start positions" do
    subject(:start) { described_class.new(map_without_start_positions).start_position(0) }

    it "puts the player at the centre of the map on both ground axes" do
      expect(start).to include("x" => 32.0, "z" => 32.0)
    end

    it "returns only the two ground-plane keys" do
      expect(start.keys).to match_array(%w[x z])
    end
  end

  describe "#start_position with declared start positions" do
    let(:map) do
      map_without_start_positions.merge(
        "start_positions" => [{ "x" => 8.0, "z" => 9.0 }, { "x" => 40.0, "z" => 41.0 }]
      )
    end

    subject(:terrain) { described_class.new(map) }

    it "uses the slot's own position and never a height key" do
      expect(terrain.start_position(1)).to eq("x" => 40.0, "z" => 41.0)
      expect(terrain.start_position(2)).to eq("x" => 8.0, "z" => 9.0)
    end
  end
end
