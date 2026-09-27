# frozen_string_literal: true

require "rails_helper"

# PROTOCOL.md §2. Browsing the lobby is public; everything that changes a match
# needs a player, and every refusal carries one of the protocol's fixed error
# codes. The client parses one JSON document per message, so the assertions here
# are on the decoded `t` and `error.code` a browser would actually read.
RSpec.describe LobbyChannel do
  let(:host) { create(:player, name: "host") }
  let(:guest) { create(:player, name: "guest") }

  # The test env runs the async adapter, which delivers on its own thread and
  # keeps no record. Announced state goes out as a broadcast rather than a
  # direct `transmit`, so the spec swaps in the test adapter and reads what
  # was actually published.
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

  # The chat rate limit is measured on the monotonic clock, which
  # `travel_to` does not move; advancing that clock is what crosses the
  # window without the suite burning wall-clock time.
  def advance_monotonic_by(seconds)
    offset = seconds
    allow(Process).to receive(:clock_gettime).and_wrap_original do |original, *args|
      value = original.call(*args)
      args.first == Process::CLOCK_MONOTONIC ? value + offset : value
    end
  end


  # `ActionCable::Channel::TestCase#perform` names the handler through
  # `action`; PROTOCOL.md names it `t`, which is what the client sends and what
  # the channel actually reads, so the spec drives it that way.
  def perform_action(data)
    perform(data["t"] || data["action"], data)
  end

  def clear_messages
    connection.transmissions.clear
  end

  # `ApplicationCable::Channel#identify_player` resolves a token through
  # `connection.class`, and the test harness's bare connection stub has no
  # connection class behind it; this gives the stub the same token lookup a
  # real cable has.
  class StubConnection < ActionCable::Channel::ConnectionStub
    def self.authenticate_token(token)
      ApplicationCable::Connection.authenticate_token(token)
    end

    # `identify_player` writes the resolved player back onto the connection;
    # the harness's singleton reader would hide that write, so the stub
    # redefines both halves against the ivar.
    attr_accessor :current_player
  end

  def subscribe_as(player)
    # The channel reads `current_player` through the connection's *identifiers*,
    # so it has to be declared as one; the harness's singleton reader would
    # then hide the write `identify_player` makes, so it is replaced with one
    # that reads the ivar the write lands in.
    @connection = StubConnection.new(current_player: player)
    @connection.singleton_class.send(:define_method, :current_player) { @current_player }
    @connection.instance_variable_set(:@current_player, player)
    subscribe
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

  def last_state
    last_of("lobby:state")
  end

  # Announced `lobby:state` reaches a subscriber as a broadcast, not a direct
  # transmit, so the announced match list and the personal `you` block have to
  # be read off the wire.
  def broadcast_to(stream)
    ActionCable.server.pubsub.broadcasts(stream).map { |raw| JSON.parse(JSON.parse(raw)) }
  end

  def announced_state
    broadcast_to(Starc::LobbyRegistry::LOBBY_STREAM).select { |m| m["t"] == "lobby:state" }.last
  end

  def announced_you(player)
    broadcast_to(Starc::LobbyRegistry.player_stream(player.id)).last&.fetch("you", nil)
  end

  def expect_error(code)
    expect(last_error).to be_present, "expected an error, got #{sent.map { |m| m['t'] }.inspect}"
    expect(last_error["code"]).to eq(code)
    expect(last_error["v"]).to eq(1)
  end

  def lobby_match(attributes = {})
    create(:match, **{ mode: "melee", map_id: Starc::Maps.default_map_id, max_players: 4 }.merge(attributes))
  end

  def seat(match, player, attributes = {})
    create(:match_player, { match: match, player: player, slot: match.match_players.count,
                            team: 1, race: "terran" }.merge(attributes))
  end

  def ready_match_with(host:, guest:)
    match = lobby_match(max_players: 2)
    seat(match, host, host: true)
    seat(match, guest, slot: 1, team: 2, race: "zerg", ready: true)
    match.match_players.find_by(player_id: host.id).update!(ready: true)
    match
  end

  # --- lobby:list ------------------------------------------------------------

  describe "lobby:list" do
    before { Starc::LobbyRegistry.instance.invalidate! }

    it "answers an anonymous subscriber, because browsing the lobby is public" do
      subscribe_as(nil)
      perform_action("t" => "lobby:list")

      expect(last_state).to be_present
      expect(last_state["you"]).to be_nil
    end

    it "returns the matches array" do
      match = lobby_match(name: "Browsable")
      subscribe_as(nil)
      perform_action("t" => "lobby:list")

      ids = last_state["matches"].map { |m| m["id"] }
      expect(ids).to include(match.id)
    end

    it "carries the summary fields the browser renders" do
      match = lobby_match(name: "Browsable", max_players: 4)
      seat(match, host, host: true)
      Starc::LobbyRegistry.instance.invalidate!
      subscribe_as(nil)
      perform_action("t" => "lobby:list")

      summary = last_state["matches"].find { |m| m["id"] == match.id }
      expect(summary).to include(
        "id" => match.id, "name" => "Browsable", "mode" => "melee",
        "map_id" => match.map_id, "max_players" => 4, "player_count" => 1,
        "status" => "lobby", "has_password" => false, "host" => "host"
      )
    end

    it "hides finished matches from the browser" do
      over = create(:match, :finished)
      subscribe_as(nil)
      perform_action("t" => "lobby:list")

      expect(last_state["matches"].map { |m| m["id"] }).not_to include(over.id)
    end

    context "with filters" do
      let!(:melee) { lobby_match(mode: "melee") }
      let!(:team) { lobby_match(mode: "team") }
      let!(:open_match) { lobby_match(password_digest: nil) }
      let!(:secret) do
        m = lobby_match
        m.update!(password_digest: BCrypt::Password.create("sekrit"))
        m
      end
      let!(:full) do
        m = lobby_match(max_players: 2)
        seat(m, host, host: true)
        seat(m, guest, slot: 1, team: 2, race: "zerg")
        m
      end

      before { Starc::LobbyRegistry.instance.invalidate! }

      it "narrows by mode" do
        subscribe_as(nil)
        perform_action("t" => "lobby:list", "filters" => { "mode" => "team" })

        ids = last_state["matches"].map { |m| m["id"] }
        expect(ids).to eq([team.id])
      end

      it "narrows by map_id" do
        other = lobby_match(map_id: Starc::Maps.ids.second)
        Starc::LobbyRegistry.instance.invalidate!
        subscribe_as(nil)
        perform_action("t" => "lobby:list", "filters" => { "map_id" => other.map_id })

        ids = last_state["matches"].map { |m| m["id"] }
        expect(ids).to eq([other.id])
      end

      it "leaves the whole list alone when the filter matches nothing" do
        subscribe_as(nil)
        perform_action("t" => "lobby:list", "filters" => { "mode" => "1v1" })

        expect(last_state["matches"]).to be_empty
      end

      it "hides a password-protected match from only_joinable" do
        subscribe_as(nil)
        perform_action("t" => "lobby:list", "filters" => { "only_joinable" => true })

        ids = last_state["matches"].map { |m| m["id"] }
        expect(ids).not_to include(secret.id)
      end

      it "leaves an open, password-free room in only_joinable" do
        subscribe_as(nil)
        perform_action("t" => "lobby:list", "filters" => { "only_joinable" => true })

        ids = last_state["matches"].map { |m| m["id"] }
        expect(ids).to include(open_match.id)
      end
    end
  end

  # --- anonymous refusals ----------------------------------------------------

  describe "an anonymous connection" do
    %w[lobby:create lobby:join lobby:leave lobby:ready lobby:settings lobby:start lobby:chat].each do |type|
      it "refuses #{type} with a fatal unauthenticated" do
        subscribe_as(nil)
        perform_action("t" => type, "match_id" => 1, "name" => "x", "mode" => "melee",
                       "map_id" => Starc::Maps.default_map_id, "text" => "hi")

        expect(last_error["code"]).to eq("unauthenticated")
        expect(last_error["fatal"]).to be(true)
      end
    end

    it "refuses lobby:create without persisting a match" do
      expect { subscribe_as(nil) && perform_action("t" => "lobby:create", "name" => "Sneaky",
                                                    "mode" => "melee", "map_id" => Starc::Maps.default_map_id) }
        .not_to change(Match, :count)
    end
  end

  # --- unknown message type --------------------------------------------------

  describe "an unknown message type" do
    it "is refused with invalid_payload instead of being dispatched" do
      subscribe_as(host)

      perform_action("t" => "no:such:action")

      expect(last_error["code"]).to eq("invalid_payload")
      expect(last_error["fatal"]).to be(false)
    end

    it "is refused even when the type names a real channel action" do
      # `handles` is the only thing between the wire and every public method on
      # the channel; a type the table does not list must never reach one.
      subscribe_as(host)
      match = lobby_match
      seat(match, host, host: true)

      perform_action("t" => "unsubscribed", "match_id" => match.id)

      expect(last_error["code"]).to eq("invalid_payload")
      expect(match.reload.match_players.count).to eq(1), "unsubscribed must not have run"
    end

    it "does not fall back to a bare `action` field the table does not list" do
      subscribe_as(host)

      perform_action("action" => "definitely_not_a_handler")

      expect(last_error["code"]).to eq("invalid_payload")
    end
  end

  # --- lobby:create ----------------------------------------------------------

  describe "lobby:create" do
    before { subscribe_as(host) }

    it "persists the match" do
      perform_action("t" => "lobby:create", "name" => "New Room",
                     "mode" => "melee", "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      match = Match.find_by(name: "New Room")
      expect(match).to be_present
      expect(match.mode).to eq("melee")
      expect(match.map_id).to eq(Starc::Maps.default_map_id)
      expect(match.max_players).to eq(4)
      expect(match).to be_lobby
    end

    it "joins the creator as host in slot 0" do
      perform_action("t" => "lobby:create", "name" => "New Room",
                     "mode" => "melee", "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      seat = Match.find_by(name: "New Room").match_players.sole
      expect(seat.player_id).to eq(host.id)
      expect(seat.slot).to eq(0)
      expect(seat).to be_host
    end

    it "registers the new match so the browser broadcast can carry it" do
      perform_action("t" => "lobby:create", "name" => "New Room",
                     "mode" => "melee", "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      match = Match.find_by(name: "New Room")
      expect(Starc::LobbyRegistry.instance.include?(match.id)).to be(true)
    end

    it "carries a populated `you` block in the lobby:state it announces" do
      perform_action("t" => "lobby:create", "name" => "New Room",
                     "mode" => "melee", "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      you = announced_you(host)
      expect(you).to include(
        "player_id" => host.id, "slot" => 0, "is_host" => true, "ready" => false
      )
      expect(you["race"]).to be_in(MatchPlayer::RACES)
    end

    it "honours a race preference the roster knows" do
      perform_action("t" => "lobby:create", "name" => "New Room", "mode" => "melee",
                     "map_id" => Starc::Maps.default_map_id, "max_players" => 4,
                     "race_preference" => "zerg")

      expect(Match.find_by(name: "New Room").match_players.sole.race).to eq("zerg")
    end

    it "ignores a race preference the roster does not know" do
      perform_action("t" => "lobby:create", "name" => "New Room", "mode" => "melee",
                     "map_id" => Starc::Maps.default_map_id, "max_players" => 4,
                     "race_preference" => "orc")

      expect(Match.find_by(name: "New Room").match_players.sole.race).to be_in(MatchPlayer::RACES)
    end

    it "rejects an empty name with invalid_payload" do
      perform_action("t" => "lobby:create", "name" => "   ", "mode" => "melee",
                     "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      expect_error("invalid_payload")
    end

    it "rejects a name over 64 characters with invalid_payload" do
      perform_action("t" => "lobby:create", "name" => "n" * 65, "mode" => "melee",
                     "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      expect_error("invalid_payload")
    end

    it "rejects an unknown mode with invalid_payload" do
      perform_action("t" => "lobby:create", "name" => "New Room", "mode" => "battle royale",
                     "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      expect_error("invalid_payload")
    end

    it "rejects an unknown map with invalid_payload" do
      perform_action("t" => "lobby:create", "name" => "New Room", "mode" => "melee",
                     "map_id" => "atlantis", "max_players" => 4)

      expect_error("invalid_payload")
    end

    it "persists a password the host can later require" do
      perform_action("t" => "lobby:create", "name" => "New Room", "mode" => "melee",
                     "map_id" => Starc::Maps.default_map_id, "max_players" => 4, "password" => "sekrit")

      expect(Match.find_by(name: "New Room").authenticate("sekrit")).to be_truthy
    end
  end

  # --- lobby:join ------------------------------------------------------------

  describe "lobby:join" do
    let(:match) { lobby_match(max_players: 2) }

    before do
      seat(match, host, host: true)
      subscribe_as(guest)
    end

    it "seats the joiner and announces the new state" do
      perform_action("t" => "lobby:join", "match_id" => match.id)

      seat = match.match_players.find_by(player_id: guest.id)
      expect(seat).to be_present
      expect(seat.slot).to eq(1)
      expect(seat).not_to be_host
      expect(announced_you(guest)).to include("match_id" => match.id, "player_id" => guest.id, "slot" => 1)
    end

    it "refuses a full match with lobby_full" do
      seat(match, create(:player), slot: 1, team: 2, race: "zerg")

      perform_action("t" => "lobby:join", "match_id" => match.id)

      expect_error("lobby_full")
      expect(match.match_players.find_by(player_id: guest.id)).to be_nil
    end

    it "refuses a second join into the same match with already_in_match" do
      perform_action("t" => "lobby:join", "match_id" => match.id)
      clear_messages

      perform_action("t" => "lobby:join", "match_id" => match.id)

      expect_error("already_in_match")
      expect(match.match_players.where(player_id: guest.id).count).to eq(1)
    end

    it "refuses an unknown match with not_found" do
      perform_action("t" => "lobby:join", "match_id" => 999_999)

      expect_error("not_found")
    end

    it "refuses a match that has already started with match_in_progress" do
      running = create(:match, :in_progress)
      seat(running, host, host: true)

      perform_action("t" => "lobby:join", "match_id" => running.id)

      expect_error("match_in_progress")
    end

    context "with a password" do
      let(:match) do
        m = lobby_match(max_players: 2)
        m.update!(password_digest: BCrypt::Password.create("sekrit"))
        m
      end

      it "refuses the wrong password with wrong_password" do
        perform_action("t" => "lobby:join", "match_id" => match.id, "password" => "guess")

        expect_error("wrong_password")
        expect(match.match_players.find_by(player_id: guest.id)).to be_nil
      end

      it "refuses a missing password with wrong_password" do
        perform_action("t" => "lobby:join", "match_id" => match.id)

        expect_error("wrong_password")
      end

      it "seats the joiner on the right password" do
        perform_action("t" => "lobby:join", "match_id" => match.id, "password" => "sekrit")

        expect(match.match_players.find_by(player_id: guest.id)).to be_present
        expect(last_error).to be_nil
      end
    end
  end

  # --- lobby:leave / lobby:ready ---------------------------------------------

  describe "lobby:leave" do
    it "removes the leaver and hands the host role to whoever is left" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      seat(match, guest, slot: 1, team: 2, race: "zerg")
      subscribe_as(host)

      perform_action("t" => "lobby:leave", "match_id" => match.id)

      expect(match.reload.match_players.pluck(:player_id)).to eq([guest.id])
      expect(match.match_players.sole).to be_host
    end

    it "abandons a match the last player left" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      subscribe_as(host)

      perform_action("t" => "lobby:leave", "match_id" => match.id)

      expect(match.reload).to be_abandoned
      expect(Starc::LobbyRegistry.instance.include?(match.id)).to be(false)
    end

    it "refuses a match the player is not in with not_found" do
      match = lobby_match
      seat(match, host, host: true)
      subscribe_as(guest)

      perform_action("t" => "lobby:leave", "match_id" => match.id)

      expect_error("not_found")
    end

    it "refuses a running match with match_in_progress" do
      running = create(:match, :in_progress)
      seat(running, host, host: true)
      subscribe_as(host)

      perform_action("t" => "lobby:leave", "match_id" => running.id)

      expect_error("match_in_progress")
    end
  end

  describe "lobby:ready" do
    it "flips the seat's ready flag" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      subscribe_as(host)

      perform_action("t" => "lobby:ready", "match_id" => match.id, "ready" => true)

      expect(match.match_players.find_by(player_id: host.id)).to be_ready
      expect(announced_you(host)["ready"]).to be(true)
    end

    it "un-readies a seat" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true, ready: true)
      subscribe_as(host)

      perform_action("t" => "lobby:ready", "match_id" => match.id, "ready" => false)

      expect(match.match_players.find_by(player_id: host.id)).not_to be_ready
    end

    it "refuses a match the player is not in with not_found" do
      match = lobby_match
      seat(match, host, host: true)
      subscribe_as(guest)

      perform_action("t" => "lobby:ready", "match_id" => match.id, "ready" => true)

      expect_error("not_found")
    end
  end

  # --- lobby:settings --------------------------------------------------------

  describe "lobby:settings" do
    it "lets the host rename the match" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      subscribe_as(host)

      perform_action("t" => "lobby:settings", "match_id" => match.id, "name" => "Renamed")

      expect(match.reload.name).to eq("Renamed")
    end

    it "refuses a non-host with not_host and changes nothing" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      seat(match, guest, slot: 1, team: 2, race: "zerg")
      subscribe_as(guest)

      perform_action("t" => "lobby:settings", "match_id" => match.id, "name" => "Hijacked")

      expect_error("not_host")
      expect(match.reload.name).not_to eq("Hijacked")
    end

    it "refuses a running match with match_in_progress" do
      running = create(:match, :in_progress, max_players: 2)
      seat(running, host, host: true)
      subscribe_as(host)

      perform_action("t" => "lobby:settings", "match_id" => running.id, "name" => "Renamed")

      expect_error("match_in_progress")
    end

    it "refuses an unknown mode with invalid_payload" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      subscribe_as(host)

      perform_action("t" => "lobby:settings", "match_id" => match.id, "mode" => "nope")

      expect_error("invalid_payload")
      expect(match.reload.mode).to eq("melee")
    end

    it "refuses shrinking the match below the players already in it" do
      match = lobby_match(max_players: 4)
      seat(match, host, host: true)
      seat(match, guest, slot: 1, team: 2, race: "zerg")
      subscribe_as(host)

      perform_action("t" => "lobby:settings", "match_id" => match.id, "max_players" => 2)

      expect_error("invalid_payload")
      expect(match.reload.max_players).to eq(4)
    end
  end

  # --- lobby:start -----------------------------------------------------------

  describe "lobby:start" do
    it "refuses a non-host with not_host" do
      match = ready_match_with(host: host, guest: guest)
      subscribe_as(guest)

      perform_action("t" => "lobby:start", "match_id" => match.id)

      expect_error("not_host")
      expect(match.reload).to be_lobby
      expect(Starc::MatchRunner.for(match.id)).to be_nil
    end

    it "refuses an unready room with not_ready" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true, ready: true)
      seat(match, guest, slot: 1, team: 2, race: "zerg", ready: false)
      subscribe_as(host)

      perform_action("t" => "lobby:start", "match_id" => match.id)

      expect_error("not_ready")
      expect(match.reload).to be_lobby
      expect(Starc::MatchRunner.for(match.id)).to be_nil
    end

    it "refuses a room with a single player with not_ready" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true, ready: true)
      subscribe_as(host)

      perform_action("t" => "lobby:start", "match_id" => match.id)

      expect_error("not_ready")
    end

    it "starts a fully ready room and gives it a runner" do
      match = ready_match_with(host: host, guest: guest)
      subscribe_as(host)

      perform_action("t" => "lobby:start", "match_id" => match.id)

      expect(match.reload).to be_in_progress
      expect(match.started_at).to be_present
      expect(Starc::MatchRunner.for(match.id)).not_to be_nil
    end

    it "refuses a second start with match_in_progress" do
      match = ready_match_with(host: host, guest: guest)
      subscribe_as(host)
      perform_action("t" => "lobby:start", "match_id" => match.id)
      clear_messages

      perform_action("t" => "lobby:start", "match_id" => match.id)

      expect_error("match_in_progress")
    end

    it "refuses an unknown match with not_found" do
      subscribe_as(host)

      perform_action("t" => "lobby:start", "match_id" => 999_999)

      expect_error("not_found")
    end
  end

  # --- lobby:chat ------------------------------------------------------------

  describe "lobby:chat" do
    let(:match) { lobby_match(max_players: 2) }

    before do
      seat(match, host, host: true)
      subscribe_as(host)
    end

    def chat_line
      last_of("lobby:chat")["lines"].last
    end

    it "pushes a line naming the speaker, the text and the time" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "gg")

      expect(chat_line).to include("player_id" => host.id, "name" => "host", "text" => "gg")
      expect(chat_line["ts"]).to be_a(Integer)
    end

    it "buffers the line for the room, so a late joiner sees it" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "gg")

      expect(Starc::LobbyRegistry.instance.chat_history(match.id).map { |l| l["text"] }).to eq(["gg"])
    end

    it "rejects an empty message with invalid_payload" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "")

      expect_error("invalid_payload")
      expect(Starc::LobbyRegistry.instance.chat_history(match.id)).to be_empty
    end

    it "accepts a message of exactly 280 characters" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "a" * 280)

      expect(last_error).to be_nil
      expect(chat_line["text"].length).to eq(280)
    end

    it "rejects a message over 280 characters with invalid_payload" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "a" * 281)

      expect_error("invalid_payload")
      expect(Starc::LobbyRegistry.instance.chat_history(match.id)).to be_empty
    end

    it "rejects a message for a match the player is not in" do
      other = lobby_match(max_players: 2)
      seat(other, guest, host: true)

      perform_action("t" => "lobby:chat", "match_id" => other.id, "text" => "gg")

      expect_error("not_found")
    end

    it "rate-limits a second message sent inside the 500 ms window" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "first")

      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "second")

      expect_error("rate_limited")
      expect(Starc::LobbyRegistry.instance.chat_history(match.id).map { |l| l["text"] }).to eq(["first"])
    end

    it "accepts the next message once the rate-limit window has passed" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "first")
      clear_messages

      # The window is measured on the monotonic clock, so it is crossed by
      # moving that clock rather than by burning wall-clock time in the suite.
      advance_monotonic_by(0.6)
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "second")

      expect(last_error).to be_nil
      expect(Starc::LobbyRegistry.instance.chat_history(match.id).map { |l| l["text"] })
        .to eq(%w[first second])
    end

    it "still rate-limits a message that arrives 0.4 s after the last one" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "first")
      clear_messages

      advance_monotonic_by(0.4)
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "second")

      expect_error("rate_limited")
    end

    it "does not rate-limit a rejected message, so a bad one does not lock the player out" do
      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "")
      clear_messages

      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "gg")

      expect(last_error).to be_nil
      expect(chat_line["text"]).to eq("gg")
    end

    it "keeps one room's chat out of another's history" do
      other = lobby_match(max_players: 2)
      seat(other, guest, host: true)
      seat(other, host, slot: 1, team: 2, race: "zerg")

      perform_action("t" => "lobby:chat", "match_id" => match.id, "text" => "private")

      expect(Starc::LobbyRegistry.instance.chat_history(other.id)).to be_empty
    end
  end

  # --- identify --------------------------------------------------------------

  describe "identify" do
    it "refuses a token that names no live session with a fatal unauthenticated" do
      subscribe_as(nil)

      perform_action("t" => "identify", "token" => "not-a-token")

      expect(last_error["code"]).to eq("unauthenticated")
      expect(last_error["fatal"]).to be(true)
    end

    it "binds the connection to the player the token belongs to and answers with a `you` block" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      session = create(:session, player: host)
      subscribe_as(nil)

      perform_action("t" => "identify", "token" => session.token)

      expect(announced_you(host)).to include("player_id" => host.id, "is_host" => true)
    end

    it "lets the newly identified player act straight away" do
      subscribe_as(nil)
      perform_action("t" => "identify", "token" => create(:session, player: host).token)
      clear_messages

      perform_action("t" => "lobby:create", "name" => "After Identify",
                     "mode" => "melee", "map_id" => Starc::Maps.default_map_id, "max_players" => 4)

      expect(Match.find_by(name: "After Identify")).to be_present
    end
  end

  # --- subscription ----------------------------------------------------------

  describe "subscribing" do
    it "sends an initial lobby:state so a tab is never blank" do
      subscribe_as(host)

      expect(last_state).to be_present
      expect(last_state["v"]).to eq(1)
      expect(last_state["matches"]).to be_an(Array)
    end

    it "replays the room's chat backlog to somebody who just sat down" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      Starc::LobbyRegistry.instance.push_chat(match.id, { "player_id" => host.id, "name" => "host",
                                                          "text" => "earlier", "ts" => 1 })

      subscribe_as(host)

      expect(last_of("lobby:chat")["lines"].map { |l| l["text"] }).to include("earlier")
    end
  end

  # --- unsubscribing ---------------------------------------------------------

  describe "unsubscribing" do
    it "abandons a lobby match the last player left the tab with" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      subscribe_as(host)
      subscribe

      unsubscribe

      expect(match.reload).to be_abandoned
      expect(Starc::LobbyRegistry.instance.include?(match.id)).to be(false)
    end

    it "hands the match on when somebody else is still in it" do
      match = lobby_match(max_players: 2)
      seat(match, host, host: true)
      seat(match, guest, slot: 1, team: 2, race: "zerg")
      subscribe_as(host)
      subscribe

      unsubscribe

      expect(match.reload).to be_lobby
      expect(match.match_players.pluck(:player_id)).to eq([guest.id])
    end

    it "leaves a running match alone, because GameChannel owns disconnect handling there" do
      running = create(:match, :in_progress, max_players: 2)
      seat(running, host, host: true)
      subscribe_as(host)
      subscribe

      unsubscribe

      expect(running.reload).to be_in_progress
    end
  end
end
