# frozen_string_literal: true

require "rails_helper"

# The simulation is the most valuable code in this repository and, until this
# file, it had no direct unit spec at all: every assertion about the world came
# from what the end-to-end suite happened to walk past. That is how three
# defects survived a fully green suite — a documented wire field that was never
# emitted, a per-viewer snapshot that nothing called, and an opening layout
# that put a whole player's workforce on one node.
#
# Every example here drives a real `Starc::Sim::World` through real ticks with
# real roster units. Nothing is stubbed and no entity is hand-built, because the
# bugs are in what the world does when nobody is looking at it.
RSpec.describe Starc::Sim::World do
  # A real two-seat melee match on the default map: two hqs, two scv rings and
  # a mineral field, exactly what `MatchRunner` builds for a live game.
  def build_world(seed: 7, map_id: nil, players: 2)
    map = map_id || Starc::Maps.default_map_id
    seats = Array.new(players) do |i|
      { id: i + 1, slot: i, race: i.zero? ? "terran" : "zerg", team: i + 1, name: "p#{i + 1}" }
    end
    described_class.new(seed: seed, map_id: map, players: seats)
  end

  def run(world, ticks)
    ticks.times { world.step! }
    world
  end

  def workers_of(world, player_id)
    world.living.select { |e| e.player_id == player_id && e.worker? && e.alive? }
  end

  def wire_entities(world, player_id: nil)
    world.snapshot["entities"].select { |h| player_id.nil? || h["pl"] == player_id }
  end

  # --- `res` -----------------------------------------------------------------

  describe "the resource echo" do
    it "puts the owning player's spendable balance on every entity" do
      world = build_world
      # 4..6 scvs, one node each, a minute of harvesting: long enough that the
      # balance has actually moved off its starting figure.
      run(world, 1_200)

      expected = world.player_states.transform_values { |s| s[:minerals] + s[:vespene] }
      expect(expected.values.uniq.size).to be > 1, "every player mined the same amount; the test proves nothing"

      for entity in wire_entities(world)
        expect(entity).to have_key("res")
        expect(entity["res"]).to eq(expected.fetch(entity["pl"]))
      end
    end

    it "echoes zero rather than omitting the field, so a broke player is not read as unknown" do
      world = build_world
      world.spend(1, world.state(1)[:minerals], world.state(1)[:vespene])

      expect(wire_entities(world, player_id: 1).map { |h| h["res"] }.uniq).to eq([0])
    end

    it "lets a player place the building its own echoed balance pays for" do
      # Two minutes of harvesting: long enough that the first cargo deliveries
      # have banked more than the cheapest building on the roster.
      world = run(build_world, 2_400)
      worker = workers_of(world, 1).first
      on_the_wire = wire_entities(world, player_id: 1).find { |h| h["id"] == worker.id }
      # A refinery is the cheapest thing a fresh Terran base can put down, so
      # this asserts on the balance rather than on a slow economy.
      building = Starc::GameData.building("refinery")

      # This is the client's own gate, verbatim: the build ghost and the build
      # hotkey both read `res` off the selected worker. With no `res` on the
      # wire it read `undefined`, the ghost was permanently invalid and a player
      # could not place a single building for the whole match.
      expect(on_the_wire["res"]).to be >= building["cost"]["minerals"]

      result = world.apply_commands(1, [{ "c" => "build", "worker_id" => worker.id,
                                          "unit_type" => "refinery",
                                          "x" => (worker.x + 6).round(2), "z" => worker.z.round(2) }])
      expect(result.applied).to eq(1)
      expect(result.rejected.map(&:code)).to be_empty
      expect(world.living.any? { |e| e.type_key == "refinery" && e.player_id == 1 }).to be(true)
    end
  end

  # --- per-viewer fields -----------------------------------------------------

  describe "the broadcast snapshot" do
    it "carries no per-viewer field, because one broadcast cannot be per-viewer" do
      world = run(build_world, 40)
      keys = wire_entities(world).flat_map(&:keys).uniq

      expect(keys).not_to include("sel")
      # The client derives this from its own seat and the team table in
      # `game:start`; PROTOCOL.md §5 says so.
      expect(world).not_to respond_to(:snapshot_for)
      expect(world).not_to respond_to(:selection_for)
    end
  end

  # --- the opening layout ----------------------------------------------------

  describe "the mineral field" do
    it "works a cluster's nodes instead of stacking every worker on one" do
      world = run(build_world, 600)
      nodes = workers_of(world, 1).map(&:harvest_node_id).compact.uniq

      # One node per scv used to be the norm: the pick was cached per owner, so
      # every worker on a side converged on whichever node was nearest.
      expect(workers_of(world, 1).size).to be >= 4
      expect(nodes.size).to be >= 2
    end

    it "gives every starting worker a node of the field it was placed next to" do
      world = run(build_world, 20)
      workers_of(world, 1).each do |worker|
        expect(worker.harvest_node_id).to be_a(Integer)
        node = world.node(worker.harvest_node_id)
        expect(node).not_to be_nil
        expect(node.rich).to be(true), "a starting field is seeded from the rich cluster by the base"
      end
    end

    it "seeds every declared cluster, not only the one nearest each base" do
      map = Starc::Maps.find(Starc::Maps.default_map_id)
      world = build_world

      for cluster in map["mineral_clusters"]
        near = world.nodes.any? do |node|
          ((node.x - cluster["x"]) ** 2) + ((node.y - cluster["z"]) ** 2) <=
            (described_class::NODE_RING_RADIUS + 0.5) ** 2
        end
        expect(near).to be(true), "cluster at #{cluster['x']},#{cluster['z']} has no nodes"
      end
    end

    it "gives every expansion candidate something to mine" do
      map = Starc::Maps.find(Starc::Maps.default_map_id)
      world = build_world

      for spot in map["expansion_candidates"]
        near = world.nodes.count do |node|
          ((node.x - spot["x"]) ** 2) + ((node.y - spot["z"]) ** 2) <= 16.0
        end
        expect(near).to be >= described_class::EXPANSION_NODE_COUNT,
                         "expansion at #{spot['x']},#{spot['z']} has #{near} nodes"
      end
    end

    it "re-picks a worker that is pulled away from the field it was serving" do
      world = run(build_world, 200)
      worker = workers_of(world, 1).first
      first = worker.harvest_node_id
      # A worker sent to the far side of the map is not still serving the
      # field it left; without the distance re-pick it trudges all the way back.
      far = Starc::Sim::Terrain.for(world.map_id).size - 20.0
      worker.order = Starc::Sim::Entity::ORDER_HARVEST
      worker.harvest_phase = :to_node
      worker.x = far
      worker.z = far

      Starc::Sim::Systems::Economy.step(world, world.dt)

      expect(worker.harvest_node_id).not_to eq(first)
    end
  end

  # --- determinism -----------------------------------------------------------

  describe "determinism" do
    it "produces byte-identical snapshots from the same seed and map" do
      one = run(build_world(seed: 99), 300)
      other = run(build_world(seed: 99), 300)

      expect(one.snapshot["entities"]).to eq(other.snapshot["entities"])
    end
  end
end
