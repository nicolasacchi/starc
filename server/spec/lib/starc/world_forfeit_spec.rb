# frozen_string_literal: true

require "rails_helper"

# `World#forfeit` is the only way a client can end a match, and it takes a
# player id straight off the wire. It has to answer two questions the old
# version could not: is this person in the match at all, and when they are,
# who is the other side.
RSpec.describe Starc::Sim::World, "#forfeit" do
  # [slot, team, race]
  FREE_FOR_ALL = [[0, nil, "terran"], [1, nil, "zerg"]].freeze

  def world_for(seats)
    described_class.new(
      seed: 4242,
      map_id: Starc::Maps.default_map_id,
      players: seats.each_with_index.map do |(_slot, team, race), index|
        { id: index + 1, slot: index, team: team, race: race, name: "p#{index + 1}" }
      end
    )
  end

  describe "a player id that is not on the roster" do
    it "changes nothing at all" do
      world = world_for(FREE_FOR_ALL)

      world.forfeit(999_999, "disconnect")

      expect(world).not_to be_finished
      expect(world.finished).to be_nil
    end

    it "is still refused after the match has ended for somebody else" do
      world = world_for(FREE_FOR_ALL)
      world.forfeit(1, "forfeit")

      world.forfeit(999_999, "disconnect")

      expect(world.finished).to include(winner: 2, reason: "forfeit")
    end
  end

  describe "who gets the win" do
    it "goes to the other team when the roster has one" do
      world = world_for([[0, 1, "terran"], [1, 1, "zerg"], [2, 2, "protoss"]])

      world.forfeit(1, "disconnect")

      expect(world.finished[:winner]).to eq(3)
    end

    it "goes to the other team from either side" do
      world = world_for([[0, 1, "terran"], [1, 1, "zerg"], [2, 2, "protoss"]])

      world.forfeit(3, "forfeit")

      expect(world.finished[:winner]).to eq(1)
    end

    it "falls back to the first other seat when the roster is a single team" do
      world = world_for([[0, 1, "terran"], [1, 1, "zerg"]])

      world.forfeit(1, "forfeit")

      expect(world.finished[:winner]).to eq(2)
    end

    it "is nobody's when the quitter is the only seat there is" do
      world = world_for([[0, 1, "terran"]])

      world.forfeit(1, "forfeit")

      expect(world.finished[:winner]).to be_nil
    end
  end
end
