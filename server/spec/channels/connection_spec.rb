# frozen_string_literal: true

require "rails_helper"
require "action_cable/connection/test_case"

# PROTOCOL.md §1: the cable itself is authenticated. A token in the query
# string or an `X-Token` header binds the player to the connection; a token
# that names no live session is refused outright, while a connection with no
# token at all stays anonymous so the public lobby browser still works.
RSpec.describe ApplicationCable::Connection do
  let!(:player) { create(:player, name: "nik") }
  let!(:session) { create(:session, player: player, token: "live-token-value") }

  # `ActionCable::Connection::TestCase` is a Minitest case, so the same
  def build_connection(params: nil, headers: {})
    uri = URI.parse(ActionCable.server.config.mount_path)
    env = {
      "QUERY_STRING" => params.nil? ? uri.query.to_s : params.to_query,
      "PATH_INFO" => uri.path
    }
    ActionDispatch::Http::Headers.from_hash(env)
                    .merge!(ActionDispatch::Http::Headers.from_hash(headers))

    request = ActionCable::Connection::TestRequest.create(env)
    request.session = {}.with_indifferent_access
    request.cookie_jar = ActionCable::Connection::TestCookieJar.new

    connection = described_class.allocate
    connection.singleton_class.include(ActionCable::Connection::TestConnection)
    connection.send(:initialize, request)
    connection
  end

  def connect(params: nil, headers: {})
    build_connection(params: params, headers: headers).tap(&:connect)
  end

  describe ".authenticate_token" do
    it "resolves a live session token to its player" do
      expect(described_class.authenticate_token("live-token-value")).to eq(player)
    end

    it "resolves nothing for a blank token, so an anonymous cable stays anonymous" do
      expect(described_class.authenticate_token(nil)).to be_nil
      expect(described_class.authenticate_token("")).to be_nil
    end

    it "resolves nothing for a token that names no session" do
      expect(described_class.authenticate_token("not-a-real-token")).to be_nil
    end

    it "resolves nothing for a session that has expired" do
      session.update!(expires_at: 1.minute.ago)

      expect(described_class.authenticate_token("live-token-value")).to be_nil
    end

    it "still resolves a session whose expiry is a minute away" do
      travel_to(session.expires_at - 1.minute) do
        expect(described_class.authenticate_token("live-token-value")).to eq(player)
      end
    end

    it "gives a database failure the same answer as an unknown token rather than raising" do
      allow(Session).to receive(:live).and_raise(ActiveRecord::StatementInvalid, "no such table")

      expect { expect(described_class.authenticate_token("live-token-value")).to be_nil }.not_to raise_error
    end
  end

  describe "#connect" do
    it "identifies the player from a token in the query string" do
      expect(connect(params: { token: "live-token-value" }).current_player).to eq(player)
    end

    it "identifies the player from an X-Token header" do
      connection = connect(headers: { "X-Token" => "live-token-value" })

      expect(connection.current_player).to eq(player)
    end

    it "prefers the query string token over the header when both are present" do
      other = create(:player)
      create(:session, player: other, token: "header-token-value")

      connection = connect(params: { token: "live-token-value" },
                           headers: { "X-Token" => "header-token-value" })

      expect(connection.current_player).to eq(player)
    end

    it "stays anonymous with no token at all" do
      expect(connect.current_player).to be_nil
    end

    it "rejects a token that names no session" do
      expect { connect(params: { token: "garbage" }) }
        .to raise_error(ActionCable::Connection::Authorization::UnauthorizedError)
    end

    it "rejects a token whose session has expired" do
      session.update!(expires_at: 1.hour.ago)

      expect { connect(headers: { "X-Token" => "live-token-value" }) }
        .to raise_error(ActionCable::Connection::Authorization::UnauthorizedError)
    end

    it "refuses to bind the player when it rejects, so no half-identified connection escapes" do
      connection = build_connection(params: { token: "garbage" })

      expect { connection.connect }.to raise_error(ActionCable::Connection::Authorization::UnauthorizedError)
      expect(connection.current_player).to be_nil
    end

    it "does not let one connection's token identify a different connection" do
      connect(params: { token: "live-token-value" })

      # A second cable arrives with no token of its own: it must not inherit
      # the identity resolved for the first one.
      other = connect

      expect(other.current_player).to be_nil
    end

    it "does not let a rejected connection poison the next good one" do
      expect { connect(params: { token: "garbage" }) }
        .to raise_error(ActionCable::Connection::Authorization::UnauthorizedError)

      expect(connect(params: { token: "live-token-value" }).current_player).to eq(player)
    end
  end
end
