# frozen_string_literal: true

require "rails_helper"

# Lobby lifecycle: index, show, create, join, leave, ready, start, forfeit.
RSpec.describe "Api::V1 matches", type: :request do
  include ActionCable::TestHelper

  def post_json(path, payload = {}, token = nil)
    post path, params: payload.to_json,
         headers: { "CONTENT_TYPE" => "application/json" }.merge(auth_headers(token).compact)
  end

  def error_code
    json_body.dig("error", "code")
  end

  def match_payload
    json_body["match"]
  end

  # A registered player with a live token, ready to hit the lobby endpoints.
  def new_player(prefix = "p")
    name, token, = register_player(name: "#{prefix}#{SecureRandom.hex(3)}")
    [Player.find_by!(name: name), token]
  end

  # The ActionCable test adapter stores whatever the coder emitted, and the
  # controllers broadcast pre-encoded JSON, so decoding is two rounds.
  def last_broadcast(stream)
    raw = broadcasts(stream).last
    message = raw.is_a?(String) ? JSON.parse(raw) : raw
    message.is_a?(String) ? JSON.parse(message) : message
  end

  def create_match(token, payload = {})
    post_json "/api/v1/matches", payload, token
    expect(response).to have_http_status(:created)
    match_payload
  end

  def join_as(token, match_id, payload = {})
    post_json "/api/v1/matches/#{match_id}/join", payload, token
  end

  describe "POST /api/v1/matches (create)" do
    it "requires authentication" do
      expect { post_json "/api/v1/matches", {} }.not_to change(Match, :count)

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end

    it "creates a lobby with the caller hosting from slot 0 on a free race" do
      player, token = new_player

      payload = create_match(token)

      match = Match.find(payload["id"])
      expect(match).to have_attributes(mode: "melee", map_id: Starc::Maps.default_map_id,
                                       max_players: 2, status: "lobby")
      expect(payload).to include("status" => "lobby", "max_players" => 2,
                                 "mode" => "melee", "map_id" => Starc::Maps.default_map_id,
                                 "player_count" => 1, "has_password" => false,
                                 "host" => player.name, "winner_player_id" => nil,
                                 "started_at" => nil, "ended_at" => nil)
      seat = payload["players"].first
      expect(seat).to include("player_id" => player.id, "slot" => 0, "host" => true,
                              "ready" => false, "team" => 1, "result" => "pending")
      expect(seat["race"]).to be_in(MatchPlayer::RACES)
      expect(payload["you"]).to include("player_id" => player.id, "slot" => 0,
                                        "is_host" => true, "ready" => false)
    end

    it "generates a fresh 32-bit seed per match" do
      _, token = new_player
      seeds = Array.new(3) { create_match(token)["seed"] }

      expect(seeds.uniq.length).to eq(3)
      seeds.each do |seed|
        expect(seed).to be_a(Integer)
        expect(seed).to be_between(0, 2**32 - 1)
      end
    end

    it "clamps max_players up to the 2 player floor" do
      _, token = new_player

      expect(create_match(token, { max_players: 1 })["max_players"]).to eq(2)
      expect(create_match(token, { max_players: 0 })["max_players"]).to eq(2)
      expect(create_match(token, { max_players: -4 })["max_players"]).to eq(2)
      expect(create_match(token, { max_players: "not-a-number" })["max_players"]).to eq(2)
    end

    it "clamps max_players down to the 8 player ceiling" do
      _, token = new_player

      expect(create_match(token, { max_players: 99 })["max_players"]).to eq(8)
      expect(create_match(token, { max_players: 9 })["max_players"]).to eq(8)
    end

    it "clamps max_players down to the chosen map's own cap" do
      _, token = new_player

      expect(create_match(token, { map_id: "chokepoint", max_players: 8 })["max_players"]).to eq(4)
      expect(create_match(token, { map_id: "cataclysm", max_players: 6 })["max_players"]).to eq(4)
      expect(create_match(token, { map_id: "shattered_isle", max_players: 8 })["max_players"]).to eq(6)
    end

    it "keeps a requested size under the map cap untouched" do
      _, token = new_player

      expect(create_match(token, { map_id: "chokepoint", max_players: 3 })["max_players"]).to eq(3)
    end

    it "rejects an unknown map_id with 422 invalid_payload" do
      _, token = new_player

      expect { post_json "/api/v1/matches", { map_id: "atlantis" }, token }.not_to change(Match, :count)

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
    end

    it "rejects an unknown mode with 422 invalid_payload" do
      _, token = new_player

      expect { post_json "/api/v1/matches", { mode: "battle-royale" }, token }.not_to change(Match, :count)

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
    end

    it "accepts every advertised mode" do
      _, token = new_player

      Match::MODES.each do |mode|
        expect(create_match(token, { mode: mode })["mode"]).to eq(mode)
      end
    end

    it "rejects a non-string password with 422 invalid_payload" do
      _, token = new_player

      expect { post_json "/api/v1/matches", { password: 1234 }, token }.not_to change(Match, :count)

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
    end

    it "rejects a body that is not a JSON object with 400 invalid_payload" do
      _, token = new_player

      post "/api/v1/matches", params: "[1,2,3]",
                              headers: { "CONTENT_TYPE" => "application/json" }.merge(auth_headers(token))

      expect(response).to have_http_status(:bad_request)
      expect(error_code).to eq("invalid_payload")
    end

    it "defaults the name to the creator's and falls back when the name is unusable" do
      player, token = new_player

      expect(create_match(token, {})["name"]).to eq("#{player.name}'s match")
      # 65 characters: past the model's 64 character limit, so the default applies.
      expect(create_match(token, { name: "n" * 65 })["name"]).to eq("#{player.name}'s match")
      expect(create_match(token, { name: "   " })["name"]).to eq("#{player.name}'s match")
      expect(create_match(token, { name: "Scrim on Altaior" })["name"]).to eq("Scrim on Altaior")
    end

    it "stores a match password as a digest and flags the lobby" do
      _, token = new_player

      payload = create_match(token, { password: "swordfish" })

      match = Match.find(payload["id"])
      expect(payload["has_password"]).to be(true)
      expect(match.password_digest).to be_present
      expect(match.password_digest).not_to eq("swordfish")
      expect(match.authenticate("swordfish")).to be(true)
    end
  end

  describe "GET /api/v1/matches (index)" do
    it "is public and reports an empty list" do
      get "/api/v1/matches"

      expect(response).to have_http_status(:ok)
      expect(json_body).to include("matches" => [], "page" => 1, "per_page" => 25, "total" => 0)
    end

    it "lists every match with its seats, newest first" do
      older = create(:match, name: "Older", created_at: 2.hours.ago)
      create(:match_player, match: older, slot: 0, host: true, race: "terran")
      newer = create(:match, name: "Newer", created_at: 1.minute.ago)
      create(:match_player, match: newer, slot: 0, host: true, race: "zerg")

      get "/api/v1/matches"

      expect(json_body["total"]).to eq(2)
      expect(json_body["matches"].map { |m| m["id"] }).to eq([newer.id, older.id])
      first = json_body["matches"].first
      expect(first["players"].first).to include("slot" => 0, "host" => true, "race" => "zerg")
    end

    it "filters by status and reports a total that matches the filter" do
      lobby = create(:match, status: :lobby)
      running = create(:match, :in_progress)
      done = create(:match, :finished)

      get "/api/v1/matches", params: { status: "in_progress" }

      expect(json_body["total"]).to eq(1)
      expect(json_body["matches"].map { |m| m["id"] }).to eq([running.id])

      get "/api/v1/matches", params: { status: "lobby" }
      expect(json_body["matches"].map { |m| m["id"] }).to eq([lobby.id])

      get "/api/v1/matches", params: { status: "finished" }
      expect(json_body["matches"].map { |m| m["id"] }).to eq([done.id])
    end

    it "filters by mode and map_id" do
      melee_altaior = create(:match, mode: "melee", map_id: "altaior")
      create(:match, mode: "team", map_id: "altaior")
      create(:match, mode: "melee", map_id: "chokepoint")

      get "/api/v1/matches", params: { mode: "team" }
      expect(json_body["total"]).to eq(1)

      get "/api/v1/matches", params: { map_id: "altaior" }
      expect(json_body["total"]).to eq(2)
      expect(json_body["matches"].map { |m| m["id"] }).to include(melee_altaior.id)

      get "/api/v1/matches", params: { mode: "melee", map_id: "altaior" }
      expect(json_body["matches"].map { |m| m["id"] }).to eq([melee_altaior.id])
      expect(json_body["total"]).to eq(1)
    end

    it "ignores an unknown status or mode filter instead of returning nothing" do
      create(:match, status: :lobby, mode: "melee")

      get "/api/v1/matches", params: { status: "nonsense", mode: "nonsense" }

      expect(json_body["total"]).to eq(1)
    end

    it "caps per_page at the server maximum" do
      3.times { create(:match) }

      get "/api/v1/matches", params: { per_page: Api::V1::MatchesController::MAX_PER_PAGE }

      expect(json_body["per_page"]).to eq(100)
      expect(json_body["total"]).to eq(3)
    end

    it "returns at most the ceiling worth of rows" do
      101.times { create(:match) }

      get "/api/v1/matches", params: { per_page: 100 }

      expect(json_body["per_page"]).to eq(100)
      expect(json_body["matches"].length).to eq(100)
      expect(json_body["total"]).to eq(101)
    end

    it "falls back to the default page size for unusable per_page and page values" do
      create(:match)

      [{ per_page: 0 }, { per_page: "many" }, { per_page: -1 }, { per_page: 5_000 }].each do |params|
        get "/api/v1/matches", params: params
        expect(json_body["per_page"]).to eq(25)
        expect(json_body["page"]).to eq(1)
        expect(json_body["matches"].length).to eq(1)
      end
    end

    it "paginates with a stable total" do
      matches = Array.new(5) { |i| create(:match, created_at: (5 - i).minutes.ago) }

      get "/api/v1/matches", params: { per_page: 2, page: 1 }
      first_page = json_body
      get "/api/v1/matches", params: { per_page: 2, page: 2 }
      second_page = json_body
      get "/api/v1/matches", params: { per_page: 2, page: 3 }
      last_page = json_body

      expect(first_page["matches"].map { |m| m["id"] }).to eq(matches.last(2).reverse.map(&:id))
      expect(second_page["matches"].map { |m| m["id"] }).to eq(matches[1..2].reverse.map(&:id))
      expect(last_page["matches"].map { |m| m["id"] }).to eq([matches.first.id])
      [first_page, second_page, last_page].each { |page| expect(page["total"]).to eq(5) }
    end

    it "returns an empty page past the end instead of erroring" do
      create(:match)

      get "/api/v1/matches", params: { page: 99 }

      expect(response).to have_http_status(:ok)
      expect(json_body["matches"]).to eq([])
      expect(json_body["total"]).to eq(1)
    end
  end

  describe "GET /api/v1/matches/:id (show)" do
    it "is public and includes every seat" do
      match = create(:match, name: "Public Lobby", max_players: 4)
      host = create(:player)
      guest = create(:player)
      create(:match_player, match: match, player: host, slot: 0, host: true, race: "terran", ready: true)
      create(:match_player, match: match, player: guest, slot: 1, race: "zerg", team: 2)

      get "/api/v1/matches/#{match.id}"

      expect(response).to have_http_status(:ok)
      expect(match_payload).to include("id" => match.id, "name" => "Public Lobby", "max_players" => 4,
                                        "player_count" => 2, "has_password" => false,
                                        "host" => host.name)
      expect(match_payload["players"].map { |s| s["player_id"] }).to eq([host.id, guest.id])
      expect(match_payload["players"].last).to include("slot" => 1, "team" => 2, "ready" => false,
                                                      "result" => "pending", "kills" => 0)
      # A spectator has no seat of their own.
      expect(match_payload["you"]).to be_nil
    end

    it "marks the caller's own seat under you" do
      match = create(:match)
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0, host: true)

      get "/api/v1/matches/#{match.id}", headers: auth_headers(player.issue_session!(ip: "127.0.0.1").token)

      expect(match_payload["you"]).to include("player_id" => player.id, "slot" => 0, "is_host" => true)
    end

    it "answers 404 not_found for an unknown or non-numeric id" do
      ["/api/v1/matches/999999", "/api/v1/matches/abc", "/api/v1/matches/"].each do |path|
        get path
        next if path.end_with?("/") # /api/v1/matches/ is the index route

        expect(response).to have_http_status(:not_found)
        expect(error_code).to eq("not_found")
      end
    end
  end

  describe "POST /api/v1/matches/:id/join" do
    it "requires authentication" do
      match = create(:match)

      expect { post_json "/api/v1/matches/#{match.id}/join" }.not_to change(MatchPlayer, :count)

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end

    it "seats the joiner in the next free slot on a free race and reports their own seat" do
      host_player, host_token = new_player
      match = create_match(host_token)
      joiner, joiner_token = new_player

      join_as(joiner_token, match["id"])

      expect(response).to have_http_status(:ok)
      expect(match_payload).to include("player_count" => 2)
      seats = match_payload["players"]
      expect(seats.map { |s| s["player_id"] }).to eq([host_player.id, joiner.id])
      expect(seats.map { |s| s["slot"] }).to eq([0, 1])
      expect(seats.map { |s| s["race"] }.uniq.length).to eq(2)
      expect(seats.last).to include("host" => false, "ready" => false, "team" => 1)
      expect(match_payload["you"]).to include("player_id" => joiner.id, "slot" => 1, "is_host" => false)
    end

    it "hands an unrequested race that nobody else holds" do
      _, host_token = new_player
      match = create_match(host_token, { mode: "team", max_players: 4 })
      _other_player, other_token = new_player
      join_as(other_token, match["id"], { race: "zerg" })
      expect(match_payload["players"].last["race"]).to eq("zerg")

      _third, third_token = new_player
      join_as(third_token, match["id"])
      expect(response).to have_http_status(:ok)
      expect(match_payload["player_count"]).to eq(3)
      # Nobody is ever seated on a race another player already holds.
      races = match_payload["players"].map { |s| s["race"] }
      expect(races.uniq.length).to eq(races.length)
      expect(races).to match_array(MatchPlayer::RACES)
    end

    it "honours a requested free race and ignores one that is not playable" do
      _, host_token = new_player
      match = create_match(host_token, { max_players: 3 })
      _second, second_token = new_player
      join_as(second_token, match["id"], { race: "protoss" })
      expect(match_payload["players"].last["race"]).to eq("protoss")

      _third, third_token = new_player
      join_as(third_token, match["id"], { race: "orc" })
      expect(response).to have_http_status(:ok)
      expect(match_payload["players"].last["race"]).to be_in(MatchPlayer::RACES - ["protoss", "terran"])
    end

    it "answers 409 lobby_full when the lobby is at max_players" do
      _, host_token = new_player
      match = create_match(host_token)
      _, joiner_token = new_player
      join_as(joiner_token, match["id"])

      _latecomer, latecomer_token = new_player
      expect { join_as(latecomer_token, match["id"]) }.not_to change(MatchPlayer, :count)

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("lobby_full")
      expect(Match.find(match["id"]).player_count).to eq(2)
    end

    it "answers 409 already_in_match on a second join" do
      _, host_token = new_player
      match = create_match(host_token)

      expect { join_as(host_token, match["id"]) }.not_to change(MatchPlayer, :count)

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("already_in_match")
    end

    it "answers 409 match_in_progress for a match that already started" do
      match = create(:match, :in_progress)
      _, token = new_player

      join_as(token, match.id)

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("match_in_progress")
    end

    it "answers 403 wrong_password without the password and 200 with it" do
      _, host_token = new_player
      match = create_match(host_token, { password: "swordfish" })
      _, joiner_token = new_player

      expect { join_as(joiner_token, match["id"]) }.not_to change(MatchPlayer, :count)
      expect(response).to have_http_status(:forbidden)
      expect(error_code).to eq("wrong_password")

      join_as(joiner_token, match["id"], { password: "wrong" })
      expect(response).to have_http_status(:forbidden)
      expect(error_code).to eq("wrong_password")

      join_as(joiner_token, match["id"], { password: "swordfish" })
      expect(response).to have_http_status(:ok)
      expect(match_payload["player_count"]).to eq(2)
    end

    it "answers 404 not_found for an unknown match" do
      _, token = new_player

      join_as(token, 424_242)

      expect(response).to have_http_status(:not_found)
      expect(error_code).to eq("not_found")
    end

    it "rejects a body that is not a JSON object with 400 invalid_payload" do
      _, host_token = new_player
      match = create_match(host_token)
      _, joiner_token = new_player

      post "/api/v1/matches/#{match["id"]}/join", params: "null,,",
                                              headers: { "CONTENT_TYPE" => "application/json" }
                                                     .merge(auth_headers(joiner_token))

      expect(response).to have_http_status(:bad_request)
      expect(error_code).to eq("invalid_payload")
    end
  end

  describe "POST /api/v1/matches/:id/leave" do
    it "hands the host flag to the lowest remaining slot" do
      _, host_token = new_player
      match = create_match(host_token, { max_players: 4 })
      seats = Array.new(2) { new_player }
      seats.each { |(_p, t)| join_as(t, match["id"]) }

      post_json "/api/v1/matches/#{match["id"]}/leave", {}, host_token

      expect(response).to have_http_status(:ok)
      remaining = match_payload["players"]
      expect(remaining.length).to eq(2)
      expect(remaining.map { |s| s["slot"] }).to eq([1, 2])
      expect(remaining.map { |s| s["host"] }).to eq([true, false])
      expect(remaining.find { |s| s["host"] }["slot"]).to eq(1)
      expect(match_payload["host"]).to eq(seats.first.first.name)
      expect(match_payload["player_count"]).to eq(2)
    end

    it "abandons the match once the last player leaves" do
      _, host_token = new_player
      match = create_match(host_token)

      post_json "/api/v1/matches/#{match["id"]}/leave", {}, host_token

      expect(response).to have_http_status(:ok)
      expect(match_payload).to include("status" => "abandoned", "player_count" => 0, "players" => [],
                                       "you" => nil)
      expect(match_payload["ended_at"]).to be_present
      expect(Match.find(match["id"])).to be_abandoned
    end

    it "frees the slot so a freed lobby can be joined again" do
      _, host_token = new_player
      match = create_match(host_token)
      _, joiner_token = new_player
      join_as(joiner_token, match["id"])

      post_json "/api/v1/matches/#{match["id"]}/leave", {}, joiner_token
      expect(match_payload["player_count"]).to eq(1)

      _, third_token = new_player
      join_as(third_token, match["id"])
      expect(response).to have_http_status(:ok)
      expect(match_payload["player_count"]).to eq(2)
      expect(match_payload["players"].map { |s| s["slot"] }).to eq([0, 1])
    end

    it "answers 404 not_found when the caller has no seat" do
      _, host_token = new_player
      match = create_match(host_token)
      _, outsider_token = new_player

      post_json "/api/v1/matches/#{match["id"]}/leave", {}, outsider_token

      expect(response).to have_http_status(:not_found)
      expect(error_code).to eq("not_found")
    end

    it "answers 409 match_in_progress once the match is running" do
      match = create(:match, :in_progress)
      player = create(:player)
      create(:match_player, match: match, player: player, host: true, slot: 0)
      token = player.issue_session!(ip: "127.0.0.1").token

      expect { post_json "/api/v1/matches/#{match.id}/leave", {}, token }
        .not_to change(MatchPlayer, :count)

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("match_in_progress")
    end

    it "requires authentication" do
      match = create(:match)

      post_json "/api/v1/matches/#{match.id}/leave"

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end
  end

  describe "POST /api/v1/matches/:id/ready" do
    it "toggles the caller's own ready flag" do
      _, host_token = new_player
      match = create_match(host_token)

      post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, host_token
      expect(response).to have_http_status(:ok)
      expect(match_payload["you"]["ready"]).to be(true)
      expect(match_payload["players"].first["ready"]).to be(true)

      post_json "/api/v1/matches/#{match["id"]}/ready", { ready: false }, host_token
      expect(response).to have_http_status(:ok)
      expect(match_payload["you"]["ready"]).to be(false)
      expect(match_payload["players"].first["ready"]).to be(false)
    end

    it "accepts the documented truthy spellings" do
      _, host_token = new_player
      match = create_match(host_token)

      ["true", "1", "on"].each do |value|
        post_json "/api/v1/matches/#{match["id"]}/ready", { ready: value }, host_token
        expect(match_payload["you"]["ready"]).to be(true), "expected #{value.inspect} to be truthy"
      end
    end

    it "only toggles the caller, never another seat" do
      _, host_token = new_player
      match = create_match(host_token)
      _, joiner_token = new_player
      join_as(joiner_token, match["id"])

      post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, joiner_token

      expect(match_payload["you"]["ready"]).to be(true)
      expect(match_payload["players"].map { |s| s["ready"] }).to eq([false, true])
    end

    it "answers 422 invalid_payload when ready is missing" do
      _, host_token = new_player
      match = create_match(host_token)

      post_json "/api/v1/matches/#{match["id"]}/ready", {}, host_token

      expect(response.status).to eq(422)
      expect(error_code).to eq("invalid_payload")
    end

    it "answers 404 not_found when the caller has no seat" do
      _, host_token = new_player
      match = create_match(host_token)
      _, outsider_token = new_player

      post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, outsider_token

      expect(response).to have_http_status(:not_found)
      expect(error_code).to eq("not_found")
    end

    it "answers 409 match_in_progress once the match is running" do
      match = create(:match, :in_progress)
      player = create(:player)
      create(:match_player, match: match, player: player, host: true, slot: 0)
      token = player.issue_session!(ip: "127.0.0.1").token

      post_json "/api/v1/matches/#{match.id}/ready", { ready: true }, token

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("match_in_progress")
    end
  end

  describe "POST /api/v1/matches/:id/start" do
    it "refuses a non-host with 403 not_host" do
      _, host_token = new_player
      match = create_match(host_token)
      _, joiner_token = new_player
      join_as(joiner_token, match["id"])

      post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, joiner_token
      post_json "/api/v1/matches/#{match["id"]}/start", {}, joiner_token

      expect(response).to have_http_status(:forbidden)
      expect(error_code).to eq("not_host")
      expect(Match.find(match["id"])).to be_lobby
    end

    it "refuses a caller with no seat with 403 not_host" do
      _, host_token = new_player
      match = create_match(host_token)
      _, outsider_token = new_player

      post_json "/api/v1/matches/#{match["id"]}/start", {}, outsider_token

      expect(response).to have_http_status(:forbidden)
      expect(error_code).to eq("not_host")
    end

    it "answers 422 not_ready while the host is alone" do
      _, host_token = new_player
      match = create_match(host_token)

      post_json "/api/v1/matches/#{match["id"]}/start", {}, host_token

      expect(response.status).to eq(422)
      expect(error_code).to eq("not_ready")
    end

    it "answers 422 not_ready while anyone is unready" do
      _, host_token = new_player
      match = create_match(host_token)
      _, joiner_token = new_player
      join_as(joiner_token, match["id"])

      post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, host_token
      post_json "/api/v1/matches/#{match["id"]}/start", {}, host_token
      expect(response.status).to eq(422)
      expect(error_code).to eq("not_ready")

      post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, joiner_token
      expect(response).to have_http_status(:ok)
    end

    it "starts the match and broadcasts the PROTOCOL §3 game:start payload" do
      host_player, host_token = new_player
      match = create_match(host_token, { map_id: "chokepoint", mode: "team" })
      joiner, joiner_token = new_player
      join_as(joiner_token, match["id"], { race: "zerg" })
      [host_token, joiner_token].each { |t| post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, t }

      clear_messages("game:#{match["id"]}")
      post_json "/api/v1/matches/#{match["id"]}/start", {}, host_token

      expect(response).to have_http_status(:ok)
      expect(match_payload).to include("status" => "in_progress", "player_count" => 2)
      expect(match_payload["started_at"]).to be_present

      expect(broadcasts("game:#{match["id"]}").length).to eq(1)
      payload = last_broadcast("game:#{match["id"]}")
      expect(payload).to include("v" => 1, "t" => "game:start", "match_id" => match["id"],
                                 "map_id" => "chokepoint", "tick_rate" => 20,
                                 "snapshot_rate" => 10, "countdown_ms" => 3000)
      expect(payload["seed"]).to eq(Match.find(match["id"]).seed)
      expect(payload["ts"]).to be_a(Integer)

      starts = Starc::Maps.find("chokepoint")["start_positions"]
      expect(payload["players"].map { |p| p["slot"] }).to eq([0, 1])
      payload["players"].each do |seat|
        expect(seat.keys).to match_array(%w[player_id slot race name team start])
        expect(seat["team"]).to be_in([1, 2])
        # Ground plane is x/z (three.js Y-up); `start` is a ground position.
        expect(seat["start"]).to include("x" => starts[seat["slot"]]["x"].to_f,
                                         "z" => starts[seat["slot"]]["z"].to_f)
      end
      expect(payload["players"].map { |p| p["player_id"] }).to eq([host_player.id, joiner.id])
      expect(payload["players"].map { |p| p["race"] }).to eq(%w[terran zerg])
      expect(payload["players"].map { |p| p["name"] }).to eq([host_player.name, joiner.name])
      # `team` mode alternates teams so allies can be told apart.
      expect(payload["players"].map { |p| p["team"] }.uniq.length).to eq(2)
    end

    it "refuses a second start with 409 match_in_progress" do
      _, host_token = new_player
      match = create_match(host_token)
      _, joiner_token = new_player
      join_as(joiner_token, match["id"])
      [host_token, joiner_token].each { |t| post_json "/api/v1/matches/#{match["id"]}/ready", { ready: true }, t }
      post_json "/api/v1/matches/#{match["id"]}/start", {}, host_token
      expect(response).to have_http_status(:ok)

      expect { post_json "/api/v1/matches/#{match["id"]}/start", {}, host_token }
        .not_to change(Match, :count)

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("match_in_progress")
    end

    it "requires authentication" do
      match = create(:match)

      post_json "/api/v1/matches/#{match.id}/start"

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end
  end

  describe "POST /api/v1/matches/:id/forfeit" do
    def running_match
      match = create(:match, mode: "team", max_players: 2, status: :in_progress, started_at: 5.minutes.ago)
      host = create(:player)
      guest = create(:player)
      create(:match_player, match: match, player: host, slot: 0, host: true, race: "terran", team: 1)
      create(:match_player, match: match, player: guest, slot: 1, race: "zerg", team: 2)
      [match, host, guest]
    end

    it "ends the match in favour of the opponent and records the result" do
      match, host, guest = running_match
      host_token = host.issue_session!(ip: "127.0.0.1").token

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      expect(response).to have_http_status(:ok)
      expect(match_payload).to include("status" => "finished", "winner_player_id" => guest.id,
                                       "end_reason" => "forfeit")
      expect(match_payload["ended_at"]).to be_present
      expect(match_payload["duration_ms"]).to be >= 0
      results = match_payload["players"].to_h { |s| [s["player_id"], s["result"]] }
      expect(results).to eq(host.id => "loss", guest.id => "win")
    end

    it "broadcasts a game:ended payload naming the winner" do
      match, host, = running_match
      host_token = host.issue_session!(ip: "127.0.0.1").token

      clear_messages("game:#{match.id}")
      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      payload = last_broadcast("game:#{match.id}")
      expect(payload).to include("t" => "game:ended", "winner" => match.reload.winner_player_id,
                                 "reason" => "forfeit", "v" => 1)
      expect(payload["replay_url"]).to eq("/api/v1/matches/#{match.id}/replay")
      expect(payload["scores"].map { |s| s["result"] }).to match_array(%w[win loss])
    end

    it "answers 409 match_in_progress for a lobby that never started" do
      match = create(:match)
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0, host: true)
      token = player.issue_session!(ip: "127.0.0.1").token

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, token

      expect(response).to have_http_status(:conflict)
      expect(error_code).to eq("match_in_progress")
    end

    it "answers 404 not_found when the caller has no seat" do
      match, = running_match
      _, outsider_token = new_player

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, outsider_token

      expect(response).to have_http_status(:not_found)
      expect(error_code).to eq("not_found")
    end

    it "requires authentication" do
      match, = running_match

      post_json "/api/v1/matches/#{match.id}/forfeit"

      expect(response).to have_http_status(:unauthorized)
      expect(error_code).to eq("unauthenticated")
    end
  end
end
