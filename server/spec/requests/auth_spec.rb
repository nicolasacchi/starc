# frozen_string_literal: true

require "rails_helper"

# Registration, login, token lifecycle, `/me`, `/me/stats` and the public
# player profile — the endpoints PROTOCOL.md §7 puts behind the bearer token.
RSpec.describe "Api::V1 auth", type: :request do
  def json_headers
    { "CONTENT_TYPE" => "application/json" }
  end

  def post_json(path, payload, headers = {})
    post path, params: payload.is_a?(String) ? payload : payload.to_json,
         headers: json_headers.merge(headers)
  end

  def get_json(path, headers = {})
    get path, headers: headers
  end

  # The exact player shape PROTOCOL.md §7 promises.
  def player_contract_keys
    %w[id name wins losses draws kills deaths resources_mined units_built rating created_at]
  end

  def error_code
    json_body.dig("error", "code")
  end

  def stats_contract_keys
    %w[matches wins losses draws win_rate kills deaths kd_ratio resources_mined units_built by_race]
  end

  describe "POST /api/v1/players" do
    it "registers a player and hands back a token the player can immediately use" do
      expect {
        post_json "/api/v1/players", { name: "Commander", password: "hunter2" }
      }.to change(Player, :count).by(1)

      expect(response).to have_http_status(:created)
      body = json_body
      expect(body["token"]).to be_a(String).and satisfy { |t| t.length >= 20 }
      expect(body["player"].keys).to match_array(player_contract_keys)
      expect(body["player"]).to include("id" => Player.find_by(name: "Commander").id,
                                        "name" => "Commander",
                                        "wins" => 0, "losses" => 0, "draws" => 0,
                                        "kills" => 0, "deaths" => 0,
                                        "resources_mined" => 0, "units_built" => 0,
                                        "rating" => Player::BASE_RATING)
      expect(body["player"]["created_at"]).to match(/\A\d{4}-\d{2}-\d{2}T/)

      get_json "/api/v1/me", auth_headers(body["token"])
      expect(response).to have_http_status(:ok)
      expect(json_body["player"]).to eq(body["player"])
    end

    it "issues the token from the sessions table only — players carries no token column" do
      post_json "/api/v1/players", { name: "Solo", password: "hunter2" }
      player = Player.find_by!(name: "Solo")

      expect(Player.column_names).not_to include("token")
      expect(player.sessions.count).to eq(1)
      expect(Session.find_by!(token: json_body["token"]).player_id).to eq(player.id)
    end

    it "rejects a duplicate name with 409 taken" do
      register_player(name: "duplicate")

      expect { post_json "/api/v1/players", { name: "duplicate", password: "hunter2" } }
        .not_to change(Player, :count)

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("taken")
    end

    it "rejects a case-variant duplicate name with 409 taken" do
      register_player(name: "MixedCase")

      post_json "/api/v1/players", { name: "mixedcase", password: "hunter2" }

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("taken")
      expect(Player.where("LOWER(name) = ?", "mixedcase").count).to eq(1)
    end

    it "trims surrounding whitespace before checking for duplicates" do
      register_player(name: "spaced")

      post_json "/api/v1/players", { name: "  spaced  ", password: "hunter2" }

      expect(error_code).to eq("taken")
      expect(response).to have_http_status(:conflict)
    end

    it "rejects names that are too long or outside [A-Za-z0-9_-] with 422 invalid_payload" do
      bad_names = ["a" * 25, "bad name", "emoji🚀", "semi;colon", "dot.name", ""]

      bad_names.each do |name|
        expect { post_json "/api/v1/players", { name: name, password: "hunter2" } }
          .not_to change(Player, :count)
        expect(response.status).to eq(422)
        expect(error_code).to eq("invalid_payload")
      end
    end

    it "rejects a name shorter than the model's three character minimum with 422 invalid_payload" do
      expect { post_json "/api/v1/players", { name: "ab", password: "hunter2" } }
        .not_to change(Player, :count)

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
    end

    it "rejects a five character password with 422 invalid_payload" do
      expect { post_json "/api/v1/players", { name: "shorty", password: "12345" } }
        .not_to change(Player, :count)

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
      expect(json_body.dig("error", "message")).to include("password")
    end

    it "accepts a six character password" do
      post_json "/api/v1/players", { name: "sixchars", password: "123456" }

      expect(response).to have_http_status(:created)
      expect(json_body["player"]["name"]).to eq("sixchars")
    end

    it "rejects a missing name, a missing password and a non-string password" do
      [{ password: "hunter2" }, { name: "nopass" }, { name: "numpass", password: 123_456 }].each do |payload|
        expect { post_json "/api/v1/players", payload }.not_to change(Player, :count)
        expect(response.status).to eq(422)
        expect(error_code).to eq("invalid_payload")
      end
    end

    it "reports every shape problem in one message" do
      post_json "/api/v1/players", { name: "", password: "1" }

      message = json_body.dig("error", "message")
      expect(message).to include("name")
      expect(message).to include("password")
    end

    it "rejects an empty body with 422 invalid_payload" do
      post_json "/api/v1/players", {}

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
    end

    it "rejects a body that is valid JSON but not an object with 400 invalid_payload" do
      expect { post_json "/api/v1/players", "[1,2,3]" }.not_to change(Player, :count)

      expect(response).to have_http_status(:bad_request)
      expect(error_code).to eq("invalid_payload")
    end

    it "rejects a malformed JSON body with 400 invalid_payload" do
      expect { post_json "/api/v1/players", '{"name": "broken", ' }.not_to change(Player, :count)

      expect(response).to have_http_status(:bad_request)
      expect(error_code).to eq("invalid_payload")
    end
  end

  describe "POST /api/v1/session" do
    it "logs in with the right password and issues a token distinct from the registration one" do
      name, register_token, = register_player(name: "loginuser")

      expect { post_json "/api/v1/session", { name: name, password: "hunter2" } }
        .to change { Session.live.count }.by(1)

      expect(response).to have_http_status(:ok)
      body = json_body
      expect(body["token"]).not_to eq(register_token)
      expect(body["player"]["name"]).to eq(name)
      expect(body["player"].keys).to match_array(player_contract_keys)

      # Both tokens stay usable: the sessions table is the single source of truth.
      [register_token, body["token"]].each do |token|
        get_json "/api/v1/me", auth_headers(token)
        expect(response).to have_http_status(:ok)
        expect(json_body["player"]["name"]).to eq(name)
      end
    end

    it "logs in regardless of the name's case" do
      name, = register_player(name: "CaseInsensitive")

      post_json "/api/v1/session", { name: name.upcase, password: "hunter2" }

      expect(response).to have_http_status(:ok)
      expect(json_body.dig("player", "name")).to eq(name)
    end

    it "answers a wrong password and an unknown name identically" do
      name, = register_player(name: "realuser")

      post_json "/api/v1/session", { name: name, password: "wrongpass" }
      wrong_password = json_body
      expect(response).to have_http_status(:unauthorized)
      expect(wrong_password.dig("error", "code")).to eq("unauthenticated")

      post_json "/api/v1/session", { name: "ghostuser", password: "hunter2" }
      unknown_name = json_body
      expect(response).to have_http_status(:unauthorized)
      expect(unknown_name.dig("error", "code")).to eq("unauthenticated")

      # Neither response may let a caller enumerate registered names.
      expect(unknown_name.dig("error", "message")).to eq(wrong_password.dig("error", "message"))
    end

    it "does not issue a session for a failed login" do
      name, = register_player(name: "failsafe")

      expect { post_json "/api/v1/session", { name: name, password: "nope123" } }
        .not_to change(Session, :count)
    end

    it "rejects a non-string password with 422 invalid_payload" do
      name, = register_player

      post_json "/api/v1/session", { name: name, password: nil }

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
    end

    it "rejects a body that is not a JSON object with 400 invalid_payload" do
      post_json "/api/v1/session", "not-an-object"

      expect(response).to have_http_status(:bad_request)
      expect(error_code).to eq("invalid_payload")
    end
  end

  describe "GET /api/v1/me" do
    it "requires a bearer token" do
      register_player

      get_json "/api/v1/me"

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end

    it "rejects a garbage token" do
      register_player

      get_json "/api/v1/me", auth_headers("not-a-real-token")

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end

    it "rejects a token that was deleted from the sessions table" do
      _, token, = register_player
      Session.find_by!(token: token).destroy!

      get_json "/api/v1/me", auth_headers(token)

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end

    it "rejects an expired token" do
      player = create(:player)
      expired = create(:session, player: player, expires_at: 1.minute.ago)

      get_json "/api/v1/me", auth_headers(expired.token)

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
      expect(expired.active?).to be(false)
    end

    it "rejects a header that is not a Bearer scheme" do
      _, token, = register_player

      get_json "/api/v1/me", { "Authorization" => "Token #{token}" }

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end

    it "rejects a malformed bearer header" do
      _, token, = register_player

      get_json "/api/v1/me", { "Authorization" => "Bearer" }

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end
  end

  describe "DELETE /api/v1/session" do
    it "revokes only the presented token" do
      _, first_token, = register_player(name: "twodevices")
      post_json "/api/v1/session", { name: "twodevices", password: "hunter2" }
      second_token = json_body["token"]

      expect { delete "/api/v1/session", headers: auth_headers(first_token) }
        .to change(Session, :count).by(-1)
      expect(response).to have_http_status(:no_content)

      get_json "/api/v1/me", auth_headers(first_token)
      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")

      get_json "/api/v1/me", auth_headers(second_token)
      expect(response).to have_http_status(:ok)
    end

    it "is a no-op without a token and leaves live sessions alone" do
      _, token, = register_player

      expect { delete "/api/v1/session" }.not_to change(Session, :count)
      expect(response).to have_http_status(:no_content)

      get_json "/api/v1/me", auth_headers(token)
      expect(response).to have_http_status(:ok)
    end
  end

  describe "GET /api/v1/me/stats" do
    def stats_for(player)
      get_json "/api/v1/me/stats", auth_headers(player.sessions.live.first.token)
      json_body
    end

    it "requires authentication" do
      create(:player, :with_session)

      get_json "/api/v1/me/stats"

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end

    it "reports zeroed stats for a player who never played" do
      player = create(:player, :with_session)

      body = stats_for(player)

      expect(response).to have_http_status(:ok)
      expect(body["player"]["name"]).to eq(player.name)
      expect(body["stats"].keys).to match_array(stats_contract_keys)
      expect(body["stats"]).to include("matches" => 0, "wins" => 0, "losses" => 0, "draws" => 0,
                                        "win_rate" => 0.0, "kills" => 0, "deaths" => 0,
                                        "kd_ratio" => 0.0, "resources_mined" => 0.0,
                                        "units_built" => 0, "by_race" => {})
      expect(body["recent_matches"]).to eq([])
    end

    it "counts only decided matches, not pending seats" do
      player = create(:player, :with_session)
      create(:match_player, player: player, result: :win, kills: 10, deaths: 2, units_built: 5)
      create(:match_player, player: player, result: :loss, kills: 0, deaths: 7, units_built: 1)
      create(:match_player, player: player, result: :pending, kills: 99, deaths: 99)

      stats = stats_for(player)["stats"]

      # A seat still awaiting a result is not a match: it must not move the W/L
      # record or the win rate the client renders on the profile page.
      expect(stats).to include("matches" => 2, "wins" => 1, "losses" => 1, "draws" => 0,
                               "win_rate" => 0.5)
      # The raw K/D totals do span every seat the player sat in.
      expect(stats).to include("kills" => 109, "deaths" => 108, "units_built" => 6)
      expect(stats["kd_ratio"]).to eq((109.0 / 108).round(4))
    end

    it "groups stats by race" do
      player = create(:player, :with_session)
      create(:match_player, player: player, race: "terran", result: :win, kills: 3, deaths: 1)
      create(:match_player, player: player, race: "zerg", result: :loss, kills: 1, deaths: 4)
      create(:match_player, player: player, race: "zerg", result: :win, kills: 2, deaths: 0)

      by_race = stats_for(player)["stats"]["by_race"]

      expect(by_race.keys).to match_array(%w[terran zerg])
      expect(by_race["terran"]).to include("matches" => 1, "wins" => 1, "win_rate" => 1.0)
      expect(by_race["zerg"]).to include("matches" => 2, "wins" => 1, "losses" => 1,
                                         "win_rate" => 0.5, "kills" => 3, "deaths" => 4,
                                         "kd_ratio" => 0.75)
    end

    it "caps recent_matches at the ten most recent" do
      player = create(:player, :with_session)
      12.times { |i| create(:match_player, player: player, result: :win, created_at: i.minutes.ago) }

      body = stats_for(player)

      expect(body["recent_matches"].length).to eq(10)
      expect(body["recent_matches"].map { |m| m["match_id"] }.uniq.length).to eq(10)
      expect(body["recent_matches"].first).to include("result" => "win", "kills" => 0, "deaths" => 0)
    end

    it "computes kd_ratio as the kill total when nothing died" do
      player = create(:player, :with_session)
      create(:match_player, player: player, result: :win, kills: 7, deaths: 0)

      expect(stats_for(player)["stats"]).to include("kd_ratio" => 7.0)
    end
  end

  describe "GET /api/v1/players/:name/stats" do
    it "is public and resolves the name case-insensitively" do
      player = create(:player, :with_session, name: "publicprofile")

      get_json "/api/v1/players/PUBLICPROFILE/stats"

      expect(response).to have_http_status(:ok)
      expect(json_body.dig("player", "name")).to eq("publicprofile")
      expect(json_body["stats"].keys).to match_array(stats_contract_keys)
    end

    it "answers 404 not_found for an unknown player" do
      get_json "/api/v1/players/nobody-here/stats"

      expect(response).to have_http_status(:not_found)
      expect(error_code).to eq("not_found")
    end

    it "does not leak another player's password digest" do
      create(:player, :with_session, name: "secrets")

      get_json "/api/v1/players/secrets/stats"

      expect(response.body).not_to include("password_digest")
      expect(json_body["player"].keys).to match_array(player_contract_keys)
    end
  end
end
