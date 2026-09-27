# frozen_string_literal: true

require "rails_helper"

# The runner is the live half of the server: a real thread, a real broadcast
# cadence and the boundary a hostile batch meets the simulation. Everything here
# runs against a real `Match` with real `MatchPlayer` rows, because the parts
# worth guarding — the schedule, the fan-out, the ownership check and the
# end-of-match writes — only exist once the world is real.
RSpec.describe Starc::MatchRunner do
  let(:one) { create(:player, name: "nik") }
  let(:two) { create(:player, name: "zzy") }

  before do
    # Stop before the reset: `reset_registry!` empties the registry, and a
    # runner that is forgotten with its tick thread still alive goes on
    # broadcasting into the next example's adapter.
    described_class.stop_all!
    reset_registry!
    @previous_pubsub = ActionCable.server.instance_variable_get(:@pubsub)
    @pubsub = ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    ActionCable.server.instance_variable_set(:@pubsub, @pubsub)
  end

  after do
    described_class.stop_all!
    reset_registry!
    ActionCable.server.instance_variable_set(:@pubsub, @previous_pubsub)
    @pubsub&.shutdown
  end

  def reset_registry!
    registry = Starc::LobbyRegistry.instance
    registry.instance_variable_set(:@entries, {})
    registry.instance_variable_set(:@chat, {})
    registry.invalidate!
    described_class.all.each { |runner| described_class.forget(runner.match_id) }
  end

  # --- helpers ---------------------------------------------------------------

  def running_match(players: [one, two])
    match = create(:match, mode: "melee", map_id: Starc::Maps.default_map_id,
                         max_players: 4, status: :in_progress, started_at: Time.current)
    players.each_with_index do |player, i|
      create(:match_player, match: match, player: player, slot: i, team: i + 1,
                            race: i.zero? ? "terran" : "zerg", host: i.zero?)
    end
    match
  end

  def launch(match = nil)
    match ||= running_match
    runner = described_class.start!(match)
    expect(runner).not_to be_nil
    runner
  end

  def broadcasts(match_id)
    ActionCable.server.pubsub.broadcasts(Starc::LobbyRegistry.game_stream(match_id))
  end

  def messages(match_id)
    broadcasts(match_id).map { |raw| JSON.parse(JSON.parse(raw)) }
  end

  def snapshots(match_id)
    messages(match_id).select { |m| m["t"] == "game:snapshot" }
  end

  # Waits for the tick loop to reach at least `tick`, so a spec never has to
  # guess how long a 50 ms step takes.
  def wait_for_tick(runner, tick, timeout: 10.0)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    sleep 0.01 while runner.world.tick < tick &&
                     Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
    runner.world.tick
  end

  def first_entity_of(player, runner)
    runner.world.entities.find { |e| e.player_id == player.id && e.alive? }
  end

  # --- the schedule ----------------------------------------------------------

  describe "the tick loop" do
    it "keeps the tick rate within tolerance of wall clock instead of drifting" do
      # The schedule is the source of truth, so 2.0 s of stepping is ~40 ticks;
      # the assertion is a band, not an exact count, because the point of the
      # test is that sleep error does not accumulate.
      runner = launch
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      wait_for_tick(runner, 40, timeout: 10.0)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started

      tick = runner.world.tick
      expected = elapsed / described_class::TICK_SECONDS
      expect(tick).to be > 0
      expect(tick).to be_within(6).of(expected)
    end

    it "does not accumulate sleep error over a long run" do
      # A loop that slept a fixed 50 ms each time would drift low; one that
      # schedules against a target time stays on it.
      runner = launch
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      wait_for_tick(runner, 55, timeout: 10.0)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started

      expect(runner.world.tick).to be >= 55
      expect(runner.world.tick).to be_within(4).of(elapsed / described_class::TICK_SECONDS)
    end

    it "reports the elapsed simulation time from the tick count" do
      runner = launch
      wait_for_tick(runner, 20, timeout: 10.0)

      expect(runner.elapsed_ms).to be_within(50).of(20 * described_class::TICK_MS)
    end
  end

  # --- snapshot cadence ------------------------------------------------------

  describe "the snapshot broadcast" do
    it "publishes a game:snapshot every 2nd tick, which is 10 Hz" do
      runner = launch
      # Every snapshot carries the tick it was taken on, so the cadence is
      # readable straight off the wire.
      wait_for_tick(runner, 30, timeout: 10.0)
      runner.stop!

      ticks = snapshots(runner.match_id).map { |m| m["tick"] }
      expect(ticks).not_to be_empty
      expect(ticks).to eq(ticks.sort)
      expect(ticks).to all(be_even), "snapshots must go out on every 2nd tick: #{ticks.inspect}"
      expect(ticks.each_cons(2).map { |a, b| b - a }.uniq).to eq([2])
    end

    it "carries the PROTOCOL §5 snapshot envelope" do
      runner = launch
      wait_for_tick(runner, 4, timeout: 10.0)
      runner.stop!

      snapshot = snapshots(runner.match_id).last
      expect(snapshot).to include("v" => 1, "t" => "game:snapshot")
      expect(snapshot["entities"]).to be_an(Array)
      expect(snapshot["events"]).to be_an(Array)
      expect(snapshot["ack"]).to be_a(Integer)
      expect(snapshot["server_ms"]).to be_a(Integer)
    end

    it "publishes nothing once the loop has stopped" do
      runner = launch
      wait_for_tick(runner, 6, timeout: 10.0)
      runner.stop!
      before_stop = broadcasts(runner.match_id).size
      sleep 0.2

      expect(broadcasts(runner.match_id).size).to eq(before_stop)
    end
  end

  # --- commands --------------------------------------------------------------

  describe "#apply_commands" do
    let(:match) { running_match }
    let!(:runner) { launch(match) }

    it "applies the valid command and rejects the other two by their batch index" do
      wait_for_tick(runner, 2, timeout: 10.0)
      unit = first_entity_of(one, runner)
      expect(unit).not_to be_nil

      result = runner.apply_commands(one.id, [
                                       { "c" => "move", "ids" => [unit.id], "x" => 40.0, "z" => 40.0 },
                                       { "c" => "teleport", "ids" => [unit.id] },
                                       { "c" => "move", "ids" => Array.new(300) { |i| i + 1 } }
                                     ], 0)

      expect(result[:applied]).to eq(1)
      rejected = result[:rejected]
      expect(rejected.map { |r| r["index"] }).to contain_exactly(1, 2)
      expect(rejected.find { |r| r["index"] == 1 }["code"]).to eq("invalid_payload")
      expect(rejected.find { |r| r["index"] == 2 }["code"]).to eq("invalid_payload")
    end

    it "rejects a command whose ids are not entity ids" do
      result = runner.apply_commands(one.id, [{ "c" => "select", "ids" => %w[a b] }], 0)

      expect(result[:rejected].map { |r| r["code"] }).to eq(["invalid_payload"])
    end

    it "rejects a batch that is not an array" do
      result = runner.apply_commands(one.id, "move everything", 0)

      expect(result[:rejected].map { |r| r["code"] }).to eq(["invalid_payload"])
    end

    it "refuses to order an entity the player does not own, with not_owner" do
      wait_for_tick(runner, 2, timeout: 10.0)
      enemy = runner.world.entities.find { |e| e.player_id == two.id && e.alive? }
      expect(enemy).not_to be_nil

      result = runner.apply_commands(one.id, [{ "c" => "move", "ids" => [enemy.id], "x" => 40.0, "z" => 40.0 }], 0)

      expect(result[:applied]).to eq(0)
      expect(result[:rejected].first["code"]).to eq("not_owner")
    end

    it "refuses a player who is not in the match at all" do
      outsider = create(:player)

      result = runner.apply_commands(outsider.id, [{ "c" => "select", "ids" => [1] }], 0)

      expect(result[:rejected].map { |r| r["code"] }).to eq(["not_owner"])
    end

    it "reports not_ready once the loop has stopped" do
      unit = first_entity_of(one, runner)
      runner.stop!

      result = runner.apply_commands(one.id, [{ "c" => "select", "ids" => [unit.id] }], 0)

      expect(result[:rejected].map { |r| r["code"] }).to eq(["not_ready"])
    end

    it "records only the commands the world accepted" do
      wait_for_tick(runner, 2, timeout: 10.0)
      unit = first_entity_of(one, runner)

      runner.apply_commands(one.id, [
                              { "c" => "select", "ids" => [unit.id] },
                              { "c" => "teleport", "ids" => [unit.id] }
                            ], 0)

      recorded = runner.send(:instance_variable_get, :@replay).commands
      expect(recorded.size).to eq(1)
      expect(recorded.first["c"]).to eq("select")
      expect(recorded.first["index"]).to eq(0)
    end

    it "never lets a client-supplied index into the replay" do
      wait_for_tick(runner, 2, timeout: 10.0)
      unit = first_entity_of(one, runner)

      runner.apply_commands(one.id, [
                              { "c" => "select", "ids" => [unit.id] },
                              { "c" => "select", "ids" => [unit.id], "index" => 99 }
                            ], 0)

      recorded = runner.send(:instance_variable_get, :@replay).commands
      expect(recorded.map { |c| c["index"] }).to eq([0, 1])
    end
  end

  # --- endings ---------------------------------------------------------------

  describe "the end of a match" do
    it "broadcasts game:ended with the winner, reason, duration, scores and a replay URL" do
      runner = launch
      runner.player_forfeits(two.id)
      wait_for_tick(runner, 2, timeout: 10.0)
      runner.stop!

      ended = messages(runner.match_id).find { |m| m["t"] == "game:ended" }
      expect(ended).to be_present, "expected a game:ended, got #{messages(runner.match_id).map { |m| m['t'] }.uniq.inspect}"
      expect(ended["v"]).to eq(1)
      expect(ended["winner"]).to eq(one.id)
      expect(ended["reason"]).to eq("forfeit")
      expect(ended["duration_ms"]).to be >= 0
      expect(ended["replay_url"]).to eq("/api/v1/matches/#{runner.match_id}/replay")
      expect(ended["scores"].map { |s| s["player_id"] }).to contain_exactly(one.id, two.id)
      expect(ended["scores"].find { |s| s["player_id"] == one.id }["result"]).to eq("win")
    end

    it "writes the replay row before the URL is handed out, so the URL resolves" do
      runner = launch
      runner.player_forfeits(two.id)
      wait_for_tick(runner, 2, timeout: 10.0)
      runner.stop!

      ended = messages(runner.match_id).find { |m| m["t"] == "game:ended" }
      expect(ended).to be_present
      # Whatever a client fetches the moment it sees this URL has to be there.
      expect(Replay.find_by(match_id: runner.match_id)).to be_present
      expect(ended["replay_url"]).not_to be_nil
    end

    it "writes the match row as finished, with the winner and the reason" do
      match = running_match
      runner = launch(match)
      runner.player_forfeits(two.id)
      wait_for_tick(runner, 2, timeout: 10.0)
      runner.stop!

      match.reload
      expect(match).to be_finished
      expect(match.winner_player_id).to eq(one.id)
      expect(match.end_reason).to eq("forfeit")
    end

    it "records the outcome on every seat" do
      match = running_match
      runner = launch(match)
      runner.player_forfeits(two.id)
      wait_for_tick(runner, 2, timeout: 10.0)
      runner.stop!

      expect(match.reload.match_players.find_by(player_id: one.id).result).to eq("win")
      expect(match.match_players.find_by(player_id: two.id).result).to eq("loss")
    end

    it "reports finished? once the world has decided" do
      runner = launch
      expect(runner.finished?).to be_falsey

      runner.player_forfeits(two.id)
      wait_for_tick(runner, 2, timeout: 10.0)
      runner.stop!

      expect(runner.finished?).to be_truthy
    end

    it "does not write a second replay row or a second game:ended when finalised twice" do
      runner = launch
      runner.player_forfeits(two.id)
      wait_for_tick(runner, 2, timeout: 10.0)
      runner.stop!
      first_end = messages(runner.match_id).count { |m| m["t"] == "game:ended" }
      expect(first_end).to eq(1)

      runner.send(:finalize!)

      expect(Replay.where(match_id: runner.match_id).count).to eq(1)
      expect(messages(runner.match_id).count { |m| m["t"] == "game:ended" }).to eq(1)
    end
  end

  # --- late subscribers ------------------------------------------------------

  describe "a subscriber that arrives mid-match" do
    it "gets game:start and then live snapshots" do
      runner = launch
      wait_for_tick(runner, 4, timeout: 10.0)

      # A second controller — a reconnecting client — reads the same stream the
      # runner publishes to, so the start payload and the following snapshots
      # both have to be there for it.
      controller = Class.new do
        def initialize(runner)
          @runner = runner
        end

        def on_subscribe
          @runner.start_payload
        end
      end.new(runner)

      expect(controller.on_subscribe[:t]).to eq("game:start")
      before = broadcasts(runner.match_id).size
      wait_for_tick(runner, 10, timeout: 2.0)

      expect(broadcasts(runner.match_id).size).to be > before
      expect(snapshots(runner.match_id).map { |m| m["tick"] }.max).to be >= 10
    end

    it "publishes to the match's own stream only" do
      runner = launch
      other = running_match
      wait_for_tick(runner, 4, timeout: 10.0)

      expect(broadcasts(other.id)).to be_empty
    end
  end

  # --- shutdown --------------------------------------------------------------

  describe "#stop!" do
    it "actually stops the thread: the tick count stops advancing" do
      runner = launch
      wait_for_tick(runner, 4, timeout: 10.0)

      runner.stop!
      settled = runner.world.tick
      sleep 0.3

      expect(runner.world.tick).to eq(settled)
      expect(runner.running?).to be(false)
    end

    it "leaves no thread alive for the match" do
      runner = launch
      wait_for_tick(runner, 2, timeout: 10.0)

      runner.stop!

      expect(runner.running?).to be(false)
    end

    it "stops a match whose world was never built" do
      runner = described_class.new(running_match)

      expect { runner.stop! }.not_to raise_error
    end
  end

  # --- launch failure --------------------------------------------------------

  describe "a launch that raises" do
    it "does not escape into the channel: it returns nil and abandons the match" do
      match = running_match
      allow(Starc::Sim::World).to receive(:new).and_raise(ArgumentError, "unknown map_id")

      runner = nil
      expect { runner = described_class.start!(match) }.not_to raise_error

      expect(runner).to be_nil
      expect(match.reload).to be_abandoned
      expect(match.end_reason).to eq("server_error")
    end

    it "leaves nothing registered, so a later adopt can try again" do
      match = running_match
      allow(Starc::Sim::World).to receive(:new).and_raise(ArgumentError, "unknown map_id")

      described_class.start!(match)

      expect(described_class.for(match.id)).to be_nil
      expect(Starc::LobbyRegistry.instance.include?(match.id)).to be(false)
    end

    it "adopt returns nil for a match that is not running" do
      lobby = create(:match, status: :lobby, map_id: Starc::Maps.default_map_id)

      expect(described_class.adopt(lobby)).to be_nil
    end
  end

  # --- registry --------------------------------------------------------------

  describe "the process registry" do
    it "hands back the same runner for a match, so a match is never simulated twice" do
      runner = launch

      expect(described_class.for(runner.match_id)).to be(runner)
      expect(described_class.running?(runner.match_id)).to be(true)
    end

    it "hands back nothing for a match it never started" do
      expect(described_class.for(999_999)).to be_nil
      expect(described_class.running?(999_999)).to be(false)
    end
  end
end
