# frozen_string_literal: true

require "rails_helper"

# The runner is the only thing that can end a live match, so everything that
# reaches it from a client has to be a player of that match, counted by
# connection, and counted once.
#
# These are the parts a green suite did not catch: a player id that is not on
# the roster, a player with two connections, a batch that overruns the command
# cap, and a second runner built over a match that is already over.
RSpec.describe Starc::MatchRunner, "presence, endings and the end-of-match writes" do
  # A minute of production grace is a minute of spec. The countdown is
  # arithmetic on a constant; every example here sits out five times the
  # window, which is long past the point where a countdown that was going to
  # fire has fired.
  let(:grace_ms) { 200 }
  let(:settle) { (grace_ms / 1000.0) * 5 }

  let(:one) { create(:player, name: "nik") }
  let(:two) { create(:player, name: "zzy") }

  before do
    stub_const("Starc::MatchRunner::FORFEIT_GRACE_MS", grace_ms)
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

  def running_match(seats)
    match = create(:match, mode: "team", map_id: Starc::Maps.default_map_id,
                         max_players: 4, status: :in_progress, started_at: Time.current)
    seats.each do |player, slot, team, race|
      create(:match_player, match: match, player: player, slot: slot, team: team,
                            race: race, host: slot.zero?)
    end
    match
  end

  def duel
    running_match([[one, 0, 1, "terran"], [two, 1, 2, "zerg"]])
  end

  def launch(match)
    runner = described_class.start!(match)
    expect(runner).not_to be_nil
    runner
  end

  def messages(match_id)
    ActionCable.server.pubsub.broadcasts(Starc::LobbyRegistry.game_stream(match_id))
             .map { |raw| JSON.parse(JSON.parse(raw)) }
  end

  # --- who may leave ---------------------------------------------------------

  describe "a player id that is not on the roster" do
    it "is ignored, so a stranger's disconnect cannot end the match" do
      match = duel
      runner = launch(match)
      runner.player_connected(one.id)
      stranger = create(:player, name: "mal")

      runner.player_disconnected(stranger.id)
      sleep settle

      expect(runner).not_to be_finished
      expect(match.reload).to be_in_progress
      expect(one.reload.wins).to eq(0)
    end

    it "cannot give up the match either" do
      match = duel
      runner = launch(match)
      stranger = create(:player, name: "mal")

      runner.player_forfeits(stranger.id)
      sleep settle

      expect(runner).not_to be_finished
      expect(match.reload).to be_in_progress
    end
  end

  # --- one player, several connections ---------------------------------------

  describe "a player with two connections" do
    it "is only counted as gone when the last one closes" do
      match = duel
      runner = launch(match)
      runner.player_connected(one.id)
      runner.player_connected(one.id)

      runner.player_disconnected(one.id)
      sleep settle
      expect(runner).not_to be_finished, "one tab closing ended the match"
      expect(match.reload).to be_in_progress

      runner.player_disconnected(one.id)
      sleep settle
      expect(runner).to be_finished
      expect(match.reload).to be_finished
      expect(match.end_reason).to eq("disconnect")
      expect(match.winner_player_id).to eq(two.id)
    end

    it "is not counted again when the same connection comes back" do
      match = duel
      runner = launch(match)
      runner.player_connected(one.id)
      runner.player_connected(one.id)
      runner.player_disconnected(one.id)

      # The reconnect races the socket the server has not noticed yet.
      runner.player_connected(one.id)
      sleep settle

      expect(runner).not_to be_finished
      expect(match.reload).to be_in_progress
    end

    it "cancels a countdown that is already running" do
      match = duel
      runner = launch(match)
      runner.player_connected(one.id)
      runner.player_disconnected(one.id)

      runner.player_connected(one.id)
      sleep settle

      expect(runner).not_to be_finished
      expect(match.reload).to be_in_progress
    end
  end

  # --- the forfeit winner ----------------------------------------------------

  describe "a forfeit in a team match" do
    it "hands the win to the other team, not to the quitter's own team-mate" do
      three = create(:player, name: "sue")
      match = running_match([[one, 0, 1, "terran"], [two, 1, 1, "zerg"], [three, 2, 2, "protoss"]])
      runner = launch(match)

      # Both of team 1 drop at the same time, so the first expiry has to decide
      # — and the seat it used to reach for is the quitter's own team-mate.
      runner.player_connected(one.id)
      runner.player_connected(two.id)
      runner.player_disconnected(one.id)
      runner.player_disconnected(two.id)
      sleep settle

      expect(match.reload).to be_finished
      expect(match.end_reason).to eq("disconnect")
      expect(match.winner_player_id).to eq(three.id)
      expect(three.reload.wins).to eq(1)
      expect(one.reload.losses).to eq(1)
      # Both countdowns are retired and only one of them decides the match:
      # the first expiry ends the game, and a second forfeit against a world
      # that has already finished is not a second ending.
      expect(messages(match.id).count { |m| m["t"] == "game:ended" }).to eq(1)
      expect(Replay.where(match_id: match.id).count).to eq(1)
      expect(runner.connections_for(one.id)).to eq(0)
      expect(runner.connections_for(two.id)).to eq(0)
    end
  end

  # --- a batch past the cap --------------------------------------------------

  describe "a command batch past the cap" do
    let(:match) { duel }
    let!(:runner) { launch(match) }

    it "reports every command it dropped, each under its own index" do
      batch = Array.new(described_class::MAX_COMMANDS_PER_BATCH + 44) { { "c" => "select", "ids" => [1] } }

      result = runner.apply_commands(one.id, batch, 0)

      dropped = result[:rejected].select { |r| r["code"] == "invalid_payload" }
      expect(dropped.map { |r| r["index"] })
        .to eq((described_class::MAX_COMMANDS_PER_BATCH...batch.size).to_a)
    end

    it "still applies the commands inside the cap" do
      batch = Array.new(described_class::MAX_COMMANDS_PER_BATCH + 10) { { "c" => "select", "ids" => [1] } }

      result = runner.apply_commands(one.id, batch, 0)

      expect(result[:applied]).to eq(described_class::MAX_COMMANDS_PER_BATCH)
      expect(result[:rejected].size).to eq(10)
    end
  end

  # --- a second runner over a finished match ---------------------------------

  describe "a reload that orphans the first runner" do
    it "applies the result once, not once per runner" do
      match = duel
      first = launch(match)
      first.player_forfeits(two.id)
      sleep 0.5
      expect(match.reload).to be_finished
      expect(one.reload.wins).to eq(1)

      # A code reload drops the class-level registry; the next subscriber's
      # `adopt` therefore builds a second runner over a match that is already
      # over. Both of them finalise.
      described_class.forget(match.id)
      second = launch(match)
      second.player_forfeits(two.id)
      sleep 0.5

      expect(match.reload).to be_finished
      expect(one.reload.wins).to eq(1), "a career counter was credited twice for one match"
      expect(two.reload.losses).to eq(1)
      expect(messages(match.id).count { |m| m["t"] == "game:ended" }).to eq(1)
      expect(Replay.where(match_id: match.id).count).to eq(1)
    end
  end

  # --- the shutdown hook -----------------------------------------------------

  describe "the process shutting down" do
    it "leaves no tick thread running when the class is unloaded" do
      first = launch(duel)
      second = launch(running_match([[one, 0, 1, "terran"], [two, 1, 2, "zerg"]]))
      wait_until { first.world && second.world }

      unload_application_classes

      expect(first.running?).to be(false), "a match thread outlived the class that owned it"
      expect(second.running?).to be(false)
    end

    # The hook is registered on the reloader, which is exactly the machinery a
    # `config.enable_reloading = true` development run uses. Running the real
    # unload callbacks is the only way to see whether the hook is on them.
    def unload_application_classes
      reloader = ActiveSupport::Reloader.new
      begin
        reloader.class_unload!
      ensure
        reloader.release_unload_lock!
      end
    end
  end

  def wait_until(timeout: 3.0)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    sleep 0.01 until yield || Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
  end
end
