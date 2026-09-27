# frozen_string_literal: true

require "rails_helper"

# `lobby:leave` had the same hole as the REST leave: only a *running* match was
# refused, so a single `lobby:leave` on a finished match destroyed the seat row
# that holds the player's result — and returned no error at all.
#
# `unsubscribed` is driven explicitly below. `ActionCable::Channel::TestCase`
# never fires it, which is exactly why the disconnect path went unexamined.
RSpec.describe LobbyChannel, type: :channel do
  before do
    reset_registry!
    @previous_pubsub = ActionCable.server.instance_variable_get(:@pubsub)
    @pubsub = ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    ActionCable.server.instance_variable_set(:@pubsub, @pubsub)
  end

  after do
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

  # `identify_player` resolves a token through `connection.class`, which the
  # harness's bare stub does not have; this gives it the real lookup and a
  # writable `current_player`.
  class StubConnection < ActionCable::Channel::ConnectionStub
    def self.authenticate_token(token)
      ApplicationCable::Connection.authenticate_token(token)
    end

    attr_accessor :current_player
  end

  def subscribe_as(player)
    @connection = StubConnection.new(current_player: player)
    @connection.singleton_class.send(:define_method, :current_player) { @current_player }
    @connection.instance_variable_set(:@current_player, player)
    subscribe(match_id: 1)
  end

  def perform_action(data)
    perform(data["t"], data)
  end

  # The channel hands the coder one JSON document per message, so a browser
  # reads the decoded `t` and `code`.
  def last_message
    JSON.parse(transmissions.last.to_s)
  end

  def played_match(status: :finished)
    match = create(:match, mode: "melee", status: status,
                         started_at: 1.hour.ago, ended_at: 30.minutes.ago, duration_ms: 1_800_000,
                         end_reason: "annihilation")
    loser = create(:player)
    winner = create(:player)
    create(:match_player, match: match, player: loser, slot: 0, host: true, race: "terran", result: :loss)
    create(:match_player, match: match, player: winner, slot: 1, race: "zerg", result: :win)
    [match, loser, winner]
  end

  def history(player)
    player.match_players.joins(:match)
          .where(matches: { status: Match.statuses.values_at("finished", "abandoned") })
          .order("matches.id")
          .map { |seat| [seat.match_id, seat.result] }
  end

  describe "lobby:leave" do
    it "refuses a finished match and keeps the result in the player's history" do
      match, player, = played_match
      before_history = history(player)
      subscribe_as(player)

      perform_action("t" => "lobby:leave", "match_id" => match.id)

      expect(last_message).to include("t" => "error", "code" => "match_finished")
      expect(history(player.reload)).to eq(before_history)
      expect(match.reload.match_players.count).to eq(2)
    end

    it "refuses an abandoned match as well" do
      match, player, = played_match(status: :abandoned)
      before_history = history(player)
      subscribe_as(player)

      perform_action("t" => "lobby:leave", "match_id" => match.id)

      expect(last_message["code"]).to eq("match_finished")
      expect(history(player.reload)).to eq(before_history)
    end

    it "still empties a lobby, which is what leaving is for" do
      match = create(:match, max_players: 2)
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0, host: true, race: "terran")
      subscribe_as(player)

      perform_action("t" => "lobby:leave", "match_id" => match.id)

      expect(match.reload.match_players).to be_empty
      expect(match).to be_abandoned
    end
  end

  describe "unsubscribed" do
    it "leaves a finished match's history alone when the lobby tab is closed" do
      match, player, = played_match
      before_history = history(player)
      subscribe_as(player)

      # Driven by hand: the harness never fires `unsubscribed`, which is how a
      # result could be destroyed on a tab close without anybody noticing.
      subscription.unsubscribed

      expect(history(player.reload)).to eq(before_history)
      expect(match.reload.match_players.count).to eq(2)
    end

    it "still gives up a lobby seat when the tab is closed" do
      match = create(:match, max_players: 2)
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0, host: true, race: "terran")
      subscribe_as(player)

      subscription.unsubscribed

      expect(match.reload.match_players).to be_empty
      expect(match).to be_abandoned
    end
  end
end
