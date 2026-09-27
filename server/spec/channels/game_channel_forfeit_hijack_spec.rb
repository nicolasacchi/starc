# frozen_string_literal: true

require "rails_helper"

# Nobody outside the match may end it, and nobody inside it may end it by
# accident.
#
# Two separate failures used to live behind one symptom — a live match
# finishing itself sixty seconds after a stranger's connection closed:
#
#   * `enter` bound `@player_id` before the membership check, so a refused
#     subscription carried a player id out through `unsubscribed` and told the
#     runner a player had left. The world then picked a winner among the
#     roster and handed slot 0 the match.
#
#   * the runner keyed presence on the player id with no connection count, so
#     one of a player's two tabs closing armed a countdown while the other was
#     still playing.
#
# These drive `unsubscribed` by hand rather than trusting the harness to fire
# it, and they assert the *outcome* — is the match still in progress, whose
# career counters moved — not that some method was called.
RSpec.describe GameChannel, "and the connections behind it" do
  # The grace window is a minute in production, which no spec is going to sit
  # through. The countdown is arithmetic on a constant, so shrinking the
  # constant shrinks the wait without changing what is being tested: the point
  # is whether it arms at all, and each example sits out well over the window.
  #
  # The multiplier is generous because these are wall-clock waits on a real
  # 50 ms tick thread: a bare 1 s sleep was long enough to lose the window
  # under load and fail intermittently. Waiting longer cannot make a correct
  # example fail — it only costs wall clock.
  let(:grace_ms) { 200 }
  let(:settle) { (grace_ms / 1000.0) * 12 }

  let(:one) { create(:player, name: "nik") }
  let(:two) { create(:player, name: "zzy") }
  let(:stranger) { create(:player, name: "mal") }

  before do
    stub_const("Starc::MatchRunner::FORFEIT_GRACE_MS", grace_ms)
    # Stop before the reset: `reset_registry!` empties the registry without
    # stopping the tick threads, so calling it first would make the
    # `stop_all!` a no-op and let a runner inherited from an earlier file keep
    # broadcasting into this example's fresh test adapter.
    Starc::MatchRunner.stop_all!
    reset_registry!
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
    Starc::MatchRunner.all.each { |runner| Starc::MatchRunner.forget(runner.match_id) }
  end

  # `identify_player` resolves a token through `connection.class`, and the
  # harness's connection stub has no connection class behind it.
  class StubConnection < ActionCable::Channel::ConnectionStub
    def self.authenticate_token(token)
      ApplicationCable::Connection.authenticate_token(token)
    end

    attr_accessor :current_player
  end

  def subscribe_as(player, match_id)
    connection = StubConnection.new(current_player: player)
    connection.singleton_class.send(:define_method, :current_player) { @current_player }
    connection.instance_variable_set(:@current_player, player)
    @connection = connection
    subscribe(match_id: match_id)
  end

  def perform_action(data)
    perform(data["t"] || data["action"], data)
  end

  def sent
    # The harness unwraps the cable envelope and keeps what the channel
    # actually transmitted.
    connection.transmissions.filter_map { |raw| raw["message"] }.map { |raw| JSON.parse(raw) }
  end

  def last_of(type)
    sent.select { |message| message["t"] == type }.last
  end

  def running_match
    match = create(:match, mode: "melee", map_id: Starc::Maps.default_map_id,
                         max_players: 4, status: :in_progress, started_at: Time.current)
    [[one, 0, 1, "terran"], [two, 1, 2, "zerg"]].each do |player, slot, team, race|
      create(:match_player, match: match, player: player, slot: slot, team: team,
                            race: race, host: slot.zero?)
    end
    match
  end

  def session_for(player)
    create(:session, player: player)
  end

  # Every alert the match stream has carried, waited out over the snapshot
  # cadence that carries them.
  def alerts(match_id, timeout: 10.0)
    stream = Starc::LobbyRegistry.game_stream(match_id)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      found = ActionCable.server.pubsub.broadcasts(stream).filter_map do |raw|
        message = JSON.parse(JSON.parse(raw))
        next unless message["t"] == "game:snapshot"

        Array(message["events"]).select { |event| event["e"] == "alert" }.map { |event| event["text"] }
      end.flatten
      return found unless found.empty?
      break if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline

      sleep 0.02
    end
    []
  end

  # --- a stranger may not end a match ---------------------------------------

  describe "a subscriber who is not a player of the match" do
    it "is refused, and its disconnect never starts a forfeit countdown" do
      match = running_match
      subscribe_as(one, match.id)
      runner = Starc::MatchRunner.for(match.id)
      expect(runner).not_to be_nil

      refusal = subscribe_as(stranger, match.id)
      expect(last_of("error")["code"]).to eq("not_found")

      # The connection goes away — twice over, because a refusal is not
      # something a second disconnect gets to undo.
      refusal.unsubscribe_from_channel

      sleep settle

      expect(runner).not_to be_finished, "a stranger's disconnect ended a match they never played in"
      expect(match.reload).to be_in_progress
      expect(match.winner_player_id).to be_nil
    end

    it "leaves the real players' career counters untouched" do
      match = running_match
      subscribe_as(one, match.id)
      runner = Starc::MatchRunner.for(match.id)

      subscribe_as(stranger, match.id).unsubscribe_from_channel
      sleep settle

      expect(runner).not_to be_finished
      expect(one.reload.wins).to eq(0)
      expect(one.reload.losses).to eq(0)
      expect(two.reload.wins).to eq(0)
      expect(two.reload.losses).to eq(0)
    end

    it "cannot give up a match it is not playing, even after being refused" do
      match = running_match
      subscribe_as(one, match.id)
      runner = Starc::MatchRunner.for(match.id)
      refusal = subscribe_as(stranger, match.id)

      # A frame straight off the socket. The harness's own `perform` refuses
      # to touch a rejected subscription, which is the framework agreeing with
      # the server; what matters is that the server ignores it too.
      refusal.perform_action("t" => "game:forfeit", "action" => "game_forfeit")
      sleep settle

      expect(runner).not_to be_finished, "a stranger gave up a match they were never seated in"
      expect(match.reload).to be_in_progress
      expect(alerts(match.id).join(" ")).not_to include(stranger.name)
    end

    it "is not left holding a seat in the runner's connection count" do
      match = running_match
      subscribe_as(one, match.id)
      runner = Starc::MatchRunner.for(match.id)

      subscribe_as(stranger, match.id).unsubscribe_from_channel
      sleep settle

      expect(runner.connections_for(stranger.id)).to eq(0)
      expect(runner).not_to be_finished
    end
  end

  # --- one tab is not the player --------------------------------------------

  describe "a player with two tabs open" do
    it "does not forfeit when one of them closes" do
      match = running_match
      subscribe_as(one, match.id)
      runner = Starc::MatchRunner.for(match.id)
      second_tab = subscribe_as(one, match.id)
      expect(runner).not_to be_finished

      second_tab.unsubscribe_from_channel
      sleep settle

      expect(runner).not_to be_finished, "closing one tab ended a match the player is still in"
      expect(match.reload).to be_in_progress
      expect(two.reload.wins).to eq(0), "the opponent was handed a win nobody played for"
    end

    it "does not tell the match that its player has gone" do
      match = running_match
      subscribe_as(one, match.id)
      subscribe_as(one, match.id).unsubscribe_from_channel
      sleep settle

      expect(alerts(match.id).join(" ")).not_to include(one.name)
    end

    it "still loses the player when the last connection goes" do
      match = running_match
      first_tab = subscribe_as(one, match.id)
      second_tab = subscribe_as(one, match.id)

      second_tab.unsubscribe_from_channel
      sleep settle
      expect(match.reload).to be_in_progress

      first_tab.unsubscribe_from_channel
      sleep settle

      expect(match.reload).to be_finished
      expect(match.end_reason).to eq("disconnect")
      expect(match.winner_player_id).to eq(two.id)
      expect(two.reload.wins).to eq(1)
    end
  end

  # --- one connection is one connection --------------------------------------

  describe "a connection that identifies more than once" do
    it "is still counted once, so its disconnect still matters" do
      match = running_match
      channel = subscribe_as(nil, match.id)
      token = session_for(one).token

      perform_action("t" => "identify", "token" => token)
      perform_action("t" => "identify", "token" => token)

      channel.unsubscribe_from_channel
      sleep settle

      expect(match.reload).to be_finished
      expect(match.end_reason).to eq("disconnect")
      expect(match.winner_player_id).to eq(two.id)
    end
  end
end
