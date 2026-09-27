# frozen_string_literal: true

require "rails_helper"

# PROTOCOL.md §1, §3. The game channel is an authenticated door onto a match:
# every subscriber is a player of it, and a client that reconnects mid-game
# gets a fresh `game:start` so it can rebuild the opening state before the next
# snapshot brings it current.
RSpec.describe GameChannel do
  let(:one) { create(:player, name: "nik") }
  let(:two) { create(:player, name: "zzy") }

  before do
    reset_registry!
    Starc::MatchRunner.stop_all!
    @previous_pubsub = ActionCable.server.instance_variable_get(:@pubsub)
    @pubsub = ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    ActionCable.server.instance_variable_set(:@pubsub, @pubsub)
  end

  after do
    Starc::MatchRunner.stop_all!
    reset_registry!
    ActionCable.server.instance_variable_set(:@pubsub, @previous_pubsub)
    @pubsub&.shutdown
  end

  def reset_registry!
    registry = Starc::LobbyRegistry.instance
    registry.instance_variable_set(:@entries, {})
    registry.instance_variable_set(:@chat, {})
    registry.invalidate!
  end

  # `identify_player` resolves a token through `connection.class`, and the
  # harness's connection stub has no connection class behind it.
  class StubConnection < ActionCable::Channel::ConnectionStub
    def self.authenticate_token(token)
      ApplicationCable::Connection.authenticate_token(token)
    end

    attr_accessor :current_player
  end

  # --- helpers ---------------------------------------------------------------

  def perform_action(data)
    perform(data["t"] || data["action"], data)
  end

  def clear_messages
    connection.transmissions.clear
  end

  def subscribe_as(player, match_id)
    @connection = StubConnection.new(current_player: player)
    @connection.singleton_class.send(:define_method, :current_player) { @current_player }
    @connection.instance_variable_set(:@current_player, player)
    subscribe(match_id: match_id)
  end

  def sent
    transmissions.map { |raw| JSON.parse(raw) }
  end

  def last_of(type)
    sent.select { |m| m["t"] == type }.last
  end

  def last_error
    last_of("error")
  end

  def expect_error(code, fatal: nil)
    expect(last_error).to be_present, "expected an error, got #{sent.map { |m| m['t'] }.inspect}"
    expect(last_error["code"]).to eq(code)
    expect(last_error["v"]).to eq(1)
    expect(last_error["fatal"]).to eq(fatal) unless fatal.nil?
  end

  def running_match(players: [one, two], status: :in_progress)
    match = create(:match, mode: "melee", map_id: Starc::Maps.default_map_id,
                         max_players: 4, status: status,
                         started_at: status == :in_progress ? Time.current : nil)
    players.each_with_index do |player, i|
      create(:match_player, match: match, player: player, slot: i, team: i + 1,
                            race: i.zero? ? "terran" : "zerg", host: i.zero?)
    end
    match
  end

  def session_for(player)
    create(:session, player: player)
  end

  # --- identify before anything else ----------------------------------------

  describe "a command before identify" do
    let(:match) { running_match }

    it "is refused with a fatal unauthenticated" do
      subscribe_as(nil, match.id)

      perform_action("t" => "game:command", "commands" => [], "from_tick" => 0)

      expect_error("unauthenticated", fatal: true)
    end

    it "refuses game:forfeit the same way" do
      subscribe_as(nil, match.id)

      perform_action("t" => "game:forfeit")

      expect_error("unauthenticated", fatal: true)
    end

    it "does not poison the subscription: identify still works afterwards" do
      # A refusal here is a plain `transmit`, not an `ActionCable::Channel::Base#reject`.
      # Rejecting would make `processable_action?` false for the rest of the
      # connection, and the client could never recover without reconnecting.
      subscribe_as(nil, match.id)
      perform_action("t" => "game:command", "commands" => [], "from_tick" => 0)
      clear_messages

      perform_action("t" => "identify", "token" => session_for(one).token)

      expect(last_error).to be_nil, "identify must not be swallowed by the earlier refusal"
      expect(last_of("game:start")).to be_present
    end

    it "leaves the subscription able to run real commands after identify" do
      subscribe_as(nil, match.id)
      perform_action("t" => "game:command", "commands" => [], "from_tick" => 0)
      perform_action("t" => "identify", "token" => session_for(one).token)
      clear_messages

      perform_action("t" => "game:command", "commands" => [], "from_tick" => 0)

      expect(last_error).to be_nil
    end
  end

  # --- identify --------------------------------------------------------------

  describe "identify" do
    it "refuses a token that names no live session with a fatal unauthenticated" do
      match = running_match
      subscribe_as(nil, match.id)

      perform_action("t" => "identify", "token" => "not-a-real-token")

      expect_error("unauthenticated", fatal: true)
    end

    it "refuses an expired session" do
      match = running_match
      session = session_for(one)
      session.update!(expires_at: 1.minute.ago)
      subscribe_as(nil, match.id)

      perform_action("t" => "identify", "token" => session.token)

      expect_error("unauthenticated", fatal: true)
    end

    it "refuses an empty token" do
      match = running_match
      subscribe_as(nil, match.id)

      perform_action("t" => "identify", "token" => "")

      expect_error("unauthenticated", fatal: true)
    end

    it "leaves the subscription usable after a refused identify" do
      match = running_match
      subscribe_as(nil, match.id)
      perform_action("t" => "identify", "token" => "nope")
      clear_messages

      perform_action("t" => "identify", "token" => session_for(one).token)

      expect(last_of("game:start")).to be_present
    end
  end

  # --- game:start ------------------------------------------------------------

  describe "game:start" do
    it "sends exactly one to a subscriber of an in-progress match" do
      match = running_match
      subscribe_as(one, match.id)

      starts = sent.select { |m| m["t"] == "game:start" }
      expect(starts.size).to eq(1)
    end

    it "carries the PROTOCOL §3 envelope field for field" do
      match = running_match
      subscribe_as(one, match.id)

      start = last_of("game:start")
      expect(start).to include(
        "v" => 1,
        "t" => "game:start",
        "match_id" => match.id,
        "seed" => match.seed,
        "map_id" => match.map_id,
        "tick_rate" => 20,
        "snapshot_rate" => 10,
        "countdown_ms" => 3000
      )
      expect(start["ts"]).to be_a(Integer)
    end

    it "carries the roster with a start position per player" do
      match = running_match
      subscribe_as(one, match.id)

      players = last_of("game:start")["players"]
      expect(players.size).to eq(2)
      expect(players.map { |p| p["player_id"] }).to contain_exactly(one.id, two.id)
      expect(players.map { |p| p["race"] }).to contain_exactly("terran", "zerg")
      expect(players.map { |p| p["name"] }).to contain_exactly("nik", "zzy")
      expect(players.map { |p| p["team"] }).to contain_exactly(1, 2)
      expect(players.map { |p| p["slot"] }).to contain_exactly(0, 1)
      players.each do |entry|
        expect(entry["start"]).to include("x" => be_a(Numeric), "y" => be_a(Numeric))
      end
    end

    it "starts a runner for the match, so snapshots are actually coming" do
      match = running_match
      subscribe_as(one, match.id)

      expect(Starc::MatchRunner.for(match.id)).not_to be_nil
    end

    it "sends game:start to a second subscriber of the same running match" do
      # This is the reconnect path: a client that comes back mid-game has to be
      # able to rebuild the opening state, not wait for the next match.
      match = running_match
      subscribe_as(one, match.id)
      clear_messages

      subscribe_as(two, match.id)

      expect(last_of("game:start")).to be_present
      expect(last_of("game:start")["match_id"]).to eq(match.id)
    end

    it "refuses a player who is not in the match with not_found" do
      match = running_match
      outsider = create(:player)

      subscribe_as(outsider, match.id)

      expect_error("not_found")
      expect(sent.select { |m| m["t"] == "game:start" }).to be_empty
    end

    it "refuses an anonymous connection nothing at all until it identifies" do
      match = running_match
      subscribe_as(nil, match.id)

      expect(sent).to be_empty
    end
  end

  # --- subscription ----------------------------------------------------------

  describe "subscribed" do
    it "refuses a match that does not exist with not_found" do
      subscribe_as(one, 999_999)

      expect_error("not_found")
    end

    it "stays silent for a match still sitting in its lobby" do
      match = running_match(status: :lobby)
      subscribe_as(one, match.id)

      expect(sent.select { |m| m["t"] == "game:start" }).to be_empty
      expect(Starc::MatchRunner.for(match.id)).to be_nil
    end

    it "does not send a second game:start when a client sends a command" do
      match = running_match
      subscribe_as(one, match.id)
      clear_messages

      perform_action("t" => "game:command", "commands" => [], "from_tick" => 0)

      expect(sent.select { |m| m["t"] == "game:start" }).to be_empty
    end
  end

  # --- game:command ----------------------------------------------------------

  describe "game:command" do
    it "answers with a game:reject carrying the world's rejection codes" do
      match = running_match
      subscribe_as(one, match.id)
      clear_messages

      perform_action("t" => "game:command", "from_tick" => 0,
                     "commands" => [{ "c" => "move", "ids" => [999_999], "x" => 5, "y" => 5 }])

      reject = last_of("game:reject")
      expect(reject).to be_present
      expect(reject["rejected"].first["code"]).to eq("no_such_entity")
      expect(reject["rejected"].first["index"]).to eq(0)
    end

    it "says nothing when the whole batch was accepted" do
      match = running_match
      subscribe_as(one, match.id)
      worker = Starc::MatchRunner.for(match.id)
      clear_messages

      # `select` is order-free, so a batch of it can never be rejected.
      perform_action("t" => "game:command", "from_tick" => 0,
                     "commands" => [{ "c" => "select", "ids" => [worker.world.entities.first.id] }])

      expect(last_of("game:reject")).to be_nil
    end

    it "refuses a batch that is not an array with invalid_payload" do
      match = running_match
      subscribe_as(one, match.id)
      clear_messages

      perform_action("t" => "game:command", "from_tick" => 0, "commands" => "everything please")

      expect(last_of("game:reject")["rejected"].first["code"]).to eq("invalid_payload")
    end
  end

  # --- game:forfeit ----------------------------------------------------------

  describe "game:forfeit" do
    it "ends the match and hands the win to the other player" do
      match = running_match
      subscribe_as(one, match.id)
      runner = Starc::MatchRunner.for(match.id)
      expect(runner).not_to be_nil

      perform_action("t" => "game:forfeit")

      # The runner's tick loop writes the ending; drive one step so the spec
      # does not have to wait on the wall clock.
      runner.send(:step) until runner.finished?
      expect(runner.finished?).to be_truthy
    end
  end

  # --- unsubscribing ---------------------------------------------------------

  describe "unsubscribed" do
    it "tells the runner a player dropped, so a forfeit countdown starts" do
      match = running_match
      subscribe_as(one, match.id)
      runner = Starc::MatchRunner.for(match.id)
      expect(runner).not_to be_nil

      unsubscribe

      # The alert the runner raises on a disconnect carries the grace period.
      alerts = runner.world.drain_events.select { |e| e["e"] == "alert" }
      expect(alerts.join).to include(one.name)
    end

    it "does not tear the match down: the game channel owns the running match" do
      match = running_match
      subscribe_as(one, match.id)
      unsubscribe

      expect(match.reload).to be_in_progress
    end
  end
end
