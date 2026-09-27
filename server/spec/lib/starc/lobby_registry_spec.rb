# frozen_string_literal: true

require "rails_helper"

# `LobbyRegistry` is the fan-out cache in front of the `Match` table: it owns the
# per-process stream names, the shared `lobby:state` broadcast and the per-match
# chat buffer. It is never a source of truth, so a stale entry must always be
# recoverable by re-reading the database.
RSpec.describe Starc::LobbyRegistry do
  subject(:registry) { described_class.instance }

  before do
    registry.instance_variable_set(:@entries, {})
    registry.instance_variable_set(:@chat, {})
    registry.invalidate!
  end

  after { registry.instance_variable_set(:@entries, {}) }

  # The test env runs the async adapter, which delivers on its own thread and
  # keeps no record; the test adapter records every published payload so a
  # spec can assert on what a subscriber would actually receive.
  before do
    @previous_pubsub = ActionCable.server.instance_variable_get(:@pubsub)
    @pubsub = ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    ActionCable.server.instance_variable_set(:@pubsub, @pubsub)
  end

  after do
    ActionCable.server.instance_variable_set(:@pubsub, @previous_pubsub)
    @pubsub&.shutdown
  end

  # The registry hands `ActionCable` a JSON document, and the server's coder
  # wraps that for the wire; a client decodes it once and parses the inner
  # document, so the published form is parsed the same way here.
  def published
    ActionCable.server.pubsub.broadcasts(described_class::LOBBY_STREAM).map { |m| JSON.parse(JSON.parse(m)) }
  end

  describe "stream names" do
    it "names a match's gameplay stream by id" do
      expect(described_class.game_stream(12)).to eq("game:12")
    end

    it "names a match's chat stream by id" do
      expect(described_class.match_chat_stream(12)).to eq("lobby:match:12")
    end

    it "names a player's personal stream by id" do
      expect(described_class.player_stream(7)).to eq("lobby:player:7")
    end

    it "coerces a string id, since a chat stream named from a string param would never match" do
      expect(described_class.game_stream("12")).to eq("game:12")
      expect(described_class.match_chat_stream("12")).to eq("lobby:match:12")
      expect(described_class.player_stream("7")).to eq("lobby:player:7")
    end
  end

  describe "entries" do
    it "round-trips a registration" do
      registry.register(5, "game:5", value: :runner)

      expect(registry.include?(5)).to be(true)
      expect(registry.for(5).id).to eq(5)
      expect(registry.for(5).stream).to eq("game:5")
      expect(registry.for(5).value).to eq(:runner)
    end

    it "normalises a string id so `for` and `include?` agree with `register`" do
      registry.register("5")

      expect(registry.for(5)).not_to be_nil
      expect(registry.for("5")).not_to be_nil
    end

    it "returns nothing for a match it does not serve" do
      expect(registry.for(99)).to be_nil
      expect(registry.include?(99)).to be(false)
    end

    it "forgets a match on unregister" do
      registry.register(5)
      registry.unregister(5)

      expect(registry.include?(5)).to be(false)
    end

    it "treats unregistering an unknown match as a no-op rather than raising" do
      expect { registry.unregister(1234) }.not_to raise_error
      expect(registry.unregister(1234)).to be_nil
    end

    it "lists the ids it is serving" do
      registry.register(1)
      registry.register(2)

      expect(registry.ids).to contain_exactly(1, 2)
    end

    it "drops a match's chat when the match is unregistered" do
      registry.register(5)
      registry.push_chat(5, { "text" => "hi" })
      registry.unregister(5)

      expect(registry.chat_history(5)).to be_empty
    end
  end

  describe "#broadcast_state" do
    before { registry.register(1) }

    it "wraps every payload in the protocol envelope" do
      payload = registry.broadcast_state

      expect(payload[:v]).to eq(1)
      expect(payload[:t]).to eq("lobby:state")
      expect(payload[:ts]).to be_a(Integer)
    end

    it "envelopes the published copy too, so a client parses one JSON document" do
      registry.broadcast_state

      envelope = published.last
      expect(envelope["v"]).to eq(1)
      expect(envelope["t"]).to eq("lobby:state")
      expect(envelope).to have_key("matches")
    end

    it "carries the listed matches in the broadcast" do
      match = create(:match, name: "Listed Room")

      ids = registry.broadcast_state[:matches].map { |m| m[:id] }
      expect(ids).to include(match.id)
    end

    it "carries no per-player block: the shared broadcast is not personal" do
      expect(registry.broadcast_state[:you]).to be_nil
    end
  end

  describe "#publish_context" do
    it "sends the `you` block on the player's own stream, not the shared one" do
      player = create(:player)
      match = create(:match)
      create(:match_player, match: match, player: player, slot: 0, host: true)

      registry.publish_context(player.id)

      expect(ActionCable.server.pubsub.broadcasts(described_class.player_stream(player.id))).not_to be_empty
      expect(ActionCable.server.pubsub.broadcasts(described_class::LOBBY_STREAM)).to be_empty
    end

    it "carries the seat the player is actually in" do
      player = create(:player)
      match = create(:match)
      create(:match_player, match: match, player: player, slot: 1, race: "zerg", ready: true, host: false)

      context = registry.publish_context(player.id)[:you]

      expect(context).to include(
        "match_id" => match.id, "player_id" => player.id,
        "slot" => 1, "race" => "zerg", "ready" => true, "is_host" => false
      )
    end

    it "sends an empty `you` block to a player who is in no live match" do
      player = create(:player)

      expect(registry.publish_context(player.id)[:you]).to be_nil
    end

    it "publishes nothing when asked about nobody" do
      expect(registry.publish_context(nil)).to be_nil
    end
  end

  describe "#matches" do
    it "lists lobby and running matches, and hides finished ones" do
      lobby = create(:match, status: :lobby)
      running = create(:match, status: :in_progress, started_at: Time.current)
      over = create(:match, :finished)

      ids = registry.matches.map { |m| m[:id] }
      expect(ids).to include(lobby.id, running.id)
      expect(ids).not_to include(over.id)
    end

    it "re-reads the database after an invalidate, so a write made behind the cache's back shows up" do
      create(:match, name: "First")
      expect(registry.matches.size).to eq(1)

      create(:match, name: "Second")
      expect(registry.matches.size).to eq(1), "the cache is meant to be served until it is dropped"

      registry.invalidate!
      expect(registry.matches.size).to eq(2)
    end

    it "drops the cache when a match is registered" do
      create(:match, name: "First")
      expect(registry.matches.size).to eq(1)

      registry.register(1)
      create(:match, name: "Second")

      expect(registry.matches.size).to eq(2)
    end

    it "does not change the answer while the cache is warm" do
      create(:match, name: "First")
      expect(registry.matches.size).to eq(1)

      create(:match, name: "Second")
      expect(registry.matches.size).to eq(1)
    end
  end

  describe "chat" do
    def line(text)
      { "player_id" => 1, "name" => "nik", "text" => text, "ts" => 0 }
    end

    it "buffers a line for the match it was pushed to" do
      registry.push_chat(5, line("gg"))

      expect(registry.chat_history(5).map { |l| l["text"] }).to eq(["gg"])
    end

    it "keeps each match's room separate" do
      registry.push_chat(5, line("in five"))
      registry.push_chat(6, line("in six"))

      expect(registry.chat_history(5).map { |l| l["text"] }).to eq(["in five"])
      expect(registry.chat_history(6).map { |l| l["text"] }).to eq(["in six"])
    end

    it "keeps the lines of one match out of another's history" do
      registry.push_chat(5, line("secret"))
      registry.push_chat(6, line("hello"))

      expect(registry.chat_history(6).map { |l| l["text"] }).not_to include("secret")
    end

    it "pushes a line to the room's stream and nobody else's" do
      registry.push_chat(5, line("gg"))

      mine = ActionCable.server.pubsub.broadcasts(described_class.match_chat_stream(5))
      theirs = ActionCable.server.pubsub.broadcasts(described_class.match_chat_stream(6))
      expect(mine.size).to eq(1)
      expect(theirs).to be_empty
      # `push_chat` broadcasts the payload hash, not a pre-encoded string.
      payload = JSON.parse(mine.first)
      expect(payload["t"]).to eq("lobby:chat")
      expect(payload["match_id"]).to eq(5)
      expect(payload["lines"].map { |l| l["text"] }).to eq(["gg"])
    end

    it "caps the buffer at 100 lines" do
      120.times { |i| registry.push_chat(5, line("line #{i}")) }

      expect(registry.chat_history(5).size).to eq(100)
    end

    it "drops the oldest lines, not the newest, when the cap bites" do
      120.times { |i| registry.push_chat(5, line("line #{i}")) }
      texts = registry.chat_history(5).map { |l| l["text"] }

      expect(texts.first).to eq("line 20")
      expect(texts.last).to eq("line 119")
      expect(texts).not_to include("line 19")
    end

    it "hands out a copy, so a subscriber cannot rewrite the room's history" do
      registry.push_chat(5, line("gg"))
      history = registry.chat_history(5)
      history.clear

      expect(registry.chat_history(5).size).to eq(1)
    end

    it "has no history for a room nobody has spoken in" do
      expect(registry.chat_history(999)).to eq([])
    end
  end
end
