# frozen_string_literal: true

require "rails_helper"

# The game stream is a match, at 10 Hz, with entity positions, HP and per-player
# state in it. `stream_from` used to run before any membership check and the
# refusal deliberately left the subscription alive, so a caller that had just
# been told "you are not a player in match 36" kept receiving the match, and a
# connection with no token at all received a whole one.
#
# PROTOCOL.md §1 sanctions keeping the *subscription* alive for an
# `unauthenticated` caller so `identify` can still work on it. It does not
# sanction delivering that match to a caller who has been told they are not a
# participant. These are the two cases, kept apart.
RSpec.describe GameChannel, type: :channel do
  let(:match) do
    create(:match, :in_progress, mode: "melee", max_players: 2).tap do |room|
      create(:match_player, match: room, player: seated, slot: 0, host: true, race: "terran")
    end
  end
  let(:seated) { create(:player, name: "seated") }
  let(:game_stream) { "game:#{match.id}" }

  before do
    Starc::MatchRunner.stop_all!
    @previous_pubsub = ActionCable.server.instance_variable_get(:@pubsub)
    @pubsub = ActionCable::SubscriptionAdapter::Test.new(ActionCable.server)
    ActionCable.server.instance_variable_set(:@pubsub, @pubsub)
  end

  after do
    Starc::MatchRunner.stop_all!
    ActionCable.server.instance_variable_set(:@pubsub, @previous_pubsub)
    @pubsub&.shutdown
  end

  # `identify_player` resolves a token through `connection.class`, which the
  # harness's bare stub does not have.
  class StubConnection < ActionCable::Channel::ConnectionStub
    def self.authenticate_token(token)
      ApplicationCable::Connection.authenticate_token(token)
    end

    attr_accessor :current_player
  end

  # `identified_by :current_player` on the real connection means a channel
  # always has a `current_player` — nil for a connection that has not
  # identified — and the harness's stub takes that identifier in its
  # constructor, which is where `delegate_connection_identifiers` reads it
  # from. `@connection` is the ivar the harness memoises its connection from.
  def open_as(player = nil)
    @connection = StubConnection.new(current_player: player)
    subscribe(match_id: match.id)
  end

  # The streams this subscription is on. A channel that refused the caller has
  # unsubscribed itself, which is the strongest possible answer: it is not on
  # the stream and cannot be put on it.
  def streams
    subscription.streams
  rescue RuntimeError
    []
  end

  def sent
    transmissions.map { |raw| JSON.parse(raw.to_s) }
  end

  def token_for(player)
    player.issue_session!(ip: "127.0.0.1").token
  end

  it "refuses a player who is not in the match and leaves them off the stream" do
    outsider = create(:player, name: "outsider")
    # A token on the connection is enough: the membership check runs during
    # `subscribed`, and the refusal unsubscribes the channel there and then.
    open_as(outsider)

    expect(streams).not_to include(game_stream)
    expect(sent.map { |m| m["t"] }).not_to include("game:start")
  end

  it "does not put an unidentified connection on the stream before it identifies" do
    open_as

    expect(streams).not_to include(game_stream)
  end

  it "still lets an unidentified connection identify itself, and only then joins the match" do
    open_as
    # The subscription is kept, so §1's `identify`-first ordering still works;
    # it just carries no match until it has proved it is a participant.
    expect(streams).not_to include(game_stream)

    perform("identify", "token" => token_for(seated))

    expect(streams).to include(game_stream)
    expect(sent.map { |m| m["t"] }).to include("game:start")
  end

  it "refuses an invalid token without putting the caller on the stream" do
    open_as

    perform("identify", "token" => "not-a-real-token")

    expect(streams).not_to include(game_stream)
  end

  it "streams the match to somebody who is in it" do
    open_as(seated)

    expect(streams).to include(game_stream)
  end
end
