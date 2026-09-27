# frozen_string_literal: true

require "rails_helper"

# The cable half of the one-live-seat rule. A player sitting in a lobby while
# also seated in a running match made `LobbyRegistry#current_seat` answer with
# the lobby, so `you.match_id` named a match that was not running and the
# browser could never enter the game. `lobby:join` and `lobby:create` — the
# second one because creating a match seats its creator — both refuse the
# second seat with the protocol's own `already_in_match` code.
RSpec.describe LobbyChannel do
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

  # `identify_player` resolves through the connection class and writes the
  # player back onto the connection; the harness's singleton reader would hide
  # that write, so both halves are redefined against the ivar.
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
    subscribe
  end

  def perform_action(data)
    perform(data["t"] || data["action"], data)
  end

  def sent
    transmissions.map { |raw| JSON.parse(raw) }
  end

  def last_error
    sent.select { |m| m["t"] == "error" }.last
  end

  def expect_error(code)
    expect(last_error).to be_present, "expected an error, got #{sent.map { |m| m['t'] }.inspect}"
    expect(last_error["code"]).to eq(code)
  end

  def clear_messages
    connection.transmissions.clear
  end

  let(:player) { create(:player, name: "joiner") }
  let(:lobby) { create(:match, max_players: 8) }

  describe "lobby:join" do
    it "refuses a second live match with already_in_match and adds no seat" do
      stale = create(:match, max_players: 8)
      create(:match_player, match: stale, player: player, slot: 0, race: "terran", host: true)
      subscribe_as(player)
      clear_messages

      expect { perform_action("t" => "lobby:join", "match_id" => lobby.id) }
        .not_to change(MatchPlayer, :count)

      expect_error("already_in_match")
      expect(last_error["message"]).to include(stale.id.to_s)
      expect(lobby.reload.player_count).to eq(0)
      expect(MatchPlayer.where(player_id: player.id).count).to eq(1)
    end

    it "refuses a second seat even when the first live match is running" do
      running = create(:match, :in_progress)
      create(:match_player, match: running, player: player, slot: 0, race: "terran")
      subscribe_as(player)
      clear_messages

      expect { perform_action("t" => "lobby:join", "match_id" => lobby.id) }
        .not_to change(MatchPlayer, :count)

      expect_error("already_in_match")
      expect(lobby.reload.player_count).to eq(0)
    end

    it "still refuses a re-join into the same match the way it always has" do
      create(:match_player, match: lobby, player: player, slot: 0, race: "terran")
      subscribe_as(player)
      clear_messages

      expect { perform_action("t" => "lobby:join", "match_id" => lobby.id) }
        .not_to change(MatchPlayer, :count)

      expect_error("already_in_match")
      expect(lobby.reload.player_count).to eq(1)
    end

    it "lets a player whose only seat is in a finished match join a new one" do
      create(:match_player, match: create(:match, :finished), player: player, slot: 0, race: "terran")
      subscribe_as(player)
      clear_messages

      perform_action("t" => "lobby:join", "match_id" => lobby.id)

      expect(last_error).to be_nil
      expect(lobby.reload.player_count).to eq(1)
      expect(MatchPlayer.live_seats_for(player.id).pluck(:match_id)).to eq([lobby.id])
    end

    it "lets a player whose only seat is in an abandoned match join a new one" do
      dead = create(:match, status: :abandoned, ended_at: 1.hour.ago)
      create(:match_player, match: dead, player: player, slot: 0, race: "terran")
      subscribe_as(player)
      clear_messages

      perform_action("t" => "lobby:join", "match_id" => lobby.id)

      expect(last_error).to be_nil
      expect(lobby.reload.player_count).to eq(1)
    end

    it "frees the player for a new match once they send lobby:leave" do
      stale = create(:match, max_players: 8)
      create(:match_player, match: stale, player: player, slot: 0, race: "terran", host: true)
      subscribe_as(player)
      clear_messages

      perform_action("t" => "lobby:leave", "match_id" => stale.id)

      expect(last_error).to be_nil
      expect(stale.reload.player_count).to eq(0)
      expect(stale).to be_abandoned

      clear_messages
      perform_action("t" => "lobby:join", "match_id" => lobby.id)

      expect(last_error).to be_nil
      expect(lobby.reload.player_count).to eq(1)
    end

    it "leaves a player in a live lobby when a finished match sits at a lower slot" do
      # The disconnect handler used to take the first seat row of any match, so
      # the finished match at slot 0 shadowed the live lobby and the player was
      # never actually freed.
      finished = create(:match, :finished)
      create(:match_player, match: finished, player: player, slot: 0, race: "terran")
      create(:match_player, match: lobby, player: player, slot: 0, race: "zerg", host: true)
      subscribe_as(player)
      clear_messages

      unsubscribe

      expect(lobby.reload.player_count).to eq(0)
      expect(finished.reload.player_count).to eq(1)
    end
  end

  describe "lobby:create" do
    it "is refused with already_in_match while seated in another live match" do
      stale = create(:match, max_players: 8)
      create(:match_player, match: stale, player: player, slot: 0, race: "terran", host: true)
      subscribe_as(player)
      clear_messages

      expect { perform_action("t" => "lobby:create", "name" => "Second", "mode" => "melee",
                                        "map_id" => Starc::Maps.default_map_id) }
        .not_to change(Match, :count)

      expect_error("already_in_match")
      expect(last_error["message"]).to include(stale.id.to_s)
    end

    it "is refused while seated in a running match" do
      create(:match_player, match: create(:match, :in_progress), player: player, slot: 0, race: "terran")
      subscribe_as(player)
      clear_messages

      expect { perform_action("t" => "lobby:create", "name" => "Second", "mode" => "melee",
                                        "map_id" => Starc::Maps.default_map_id) }
        .not_to change(Match, :count)

      expect_error("already_in_match")
    end

    it "is allowed when the only seat is in a finished match" do
      create(:match_player, match: create(:match, :finished), player: player, slot: 0, race: "terran")
      subscribe_as(player)
      clear_messages

      expect { perform_action("t" => "lobby:create", "name" => "Fresh", "mode" => "melee",
                                        "map_id" => Starc::Maps.default_map_id) }
        .to change(Match, :count).by(1)

      expect(last_error).to be_nil
      expect(MatchPlayer.live_seats_for(player.id).count).to eq(1)
    end
  end
end
