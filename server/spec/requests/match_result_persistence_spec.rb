# frozen_string_literal: true

require "rails_helper"

# The end of a match is the simulation's to decide, whoever asked for it.
#
# A forfeit used to be written straight to the database: the match row said
# `finished` while the world kept stepping and broadcasting snapshots for the
# rest of the 90-minute timeout, `game:ended` went out twice in two different
# shapes, and the runner's own result handling — career counters, replay,
# leaderboard — never ran at all.
#
# These examples drive the real HTTP path and then read the world: how many
# `game:ended` documents the clients saw, whether the simulation is still
# stepping afterwards, and what actually landed in the database.
RSpec.describe "A match that is finished", type: :request do
  include ActionCable::TestHelper
  # The forfeit is decided by a real tick thread; it must not outlive the
  # example that started it.
  include MatchRunnerTeardown

  def post_json(path, payload = {}, token = nil)
    post path, params: payload.to_json,
         headers: { "CONTENT_TYPE" => "application/json" }.merge(auth_headers(token).compact)
  end

  def json_body
    JSON.parse(response.body)
  end

  def new_player
    name, token, = register_player
    [Player.find_by!(name: name), token]
  end

  # Two players in a lobby, both registered through the real endpoints.
  def waiting_room(host_token)
    post_json("/api/v1/matches", { mode: "melee", max_players: 2 }, host_token)
    match_id = JSON.parse(response.body).fetch("match").fetch("id")
    guest, guest_token = new_player
    post_json("/api/v1/matches/#{match_id}/join", {}, guest_token)
    [match_id, host_token, guest, guest_token]
  end

  # The forfeit is finished by the runner's tick thread, so the broadcast can
  # land a moment after the HTTP response. Waiting for the first one keeps the
  # "exactly one" assertion about a document that has actually been sent.
  def await_ended(match_id, timeout: 10)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    sleep 0.01 while ended_broadcasts(match_id).empty? &&
                     Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
    sleep 0.2
    ended_broadcasts(match_id)
  end

  # Every `game:ended` the match stream has carried, decoded. The test adapter
  # stores what the coder emitted and the server broadcasts pre-encoded JSON.
  def ended_broadcasts(match_id)
    broadcasts("game:#{match_id}").filter_map do |raw|
      message = raw.is_a?(String) ? JSON.parse(raw) : raw
      message = JSON.parse(message) if message.is_a?(String)
      message if message.is_a?(Hash) && message["t"] == "game:ended"
    end
  end

  def snapshot_broadcasts(match_id)
    broadcasts("game:#{match_id}").count do |raw|
      message = raw.is_a?(String) ? JSON.parse(raw) : raw
      message = JSON.parse(message) if message.is_a?(String)
      message.is_a?(Hash) && message["t"] == "game:snapshot"
    end
  end

  # A running match with two seats, adopted by this process so it is really
  # being simulated rather than only marked as running. Both modes are
  # exercised: a team match decides across teams, a melee match across seats.
  def running_match(mode: "melee")
    host, host_token = new_player
    guest, = new_player
    match = create(:match, mode: mode, max_players: 2, status: :in_progress, started_at: Time.current)
    create(:match_player, match: match, player: host, slot: 0, host: true, race: "terran")
    create(:match_player, match: match, player: guest, slot: 1, race: "zerg")
    [match, host, guest, host_token]
  end

  describe "POST /api/v1/matches/:id/forfeit" do
    it "ends the match, credits the winner and records the loser's defeat" do
      match, host, guest, host_token = running_match

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      expect(response).to have_http_status(:ok)
      match.reload
      expect(match).to be_finished
      expect(match.winner_player_id).to eq(guest.id)
      expect(match.end_reason).to eq("forfeit")
      results = match.match_players.ordered.to_h { |seat| [seat.player_id, seat.result] }
      expect(results).to eq(host.id => "loss", guest.id => "win")
    end

    it "tells the clients the match is over exactly once" do
      match, _host, _guest, host_token = running_match

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      ended = await_ended(match.id)
      expect(ended.size).to eq(1), "expected one game:ended, saw: #{ended.map { |m| m['reason'] }.inspect}"
      expect(ended.first).to include("winner" => match.reload.winner_player_id,
                                     "reason" => "forfeit", "v" => 1)
      expect(ended.first["scores"].map { |score| score["result"] }).to match_array(%w[win loss])
    end

    it "stops the simulation instead of leaving it stepping against a finished match" do
      match, _host, _guest, host_token = running_match

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token
      expect(response).to have_http_status(:ok)

      # The runner is deregistered when it finalises, so a live one here is a
      # thread that is still broadcasting.
      expect(Starc::MatchRunner.running?(match.id)).to be(false)

      before = broadcasts("game:#{match.id}").size
      sleep 0.4
      expect(broadcasts("game:#{match.id}").size).to eq(before),
                                            "the match kept broadcasting after it had ended"
    end

    it "credits the career counters the result path owns" do
      match, host, guest, host_token = running_match

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      expect(guest.reload.wins).to eq(1)
      expect(host.reload.losses).to eq(1)
    end

    it "writes the replay, so the replay_url in game:ended resolves" do
      match, _host, _guest, host_token = running_match

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      expect(match.reload.replay).to be_present
      get "/api/v1/matches/#{match.id}/replay"
      expect(response).to have_http_status(:ok)
      expect(json_body["header"]["winner"]).to eq(match.winner_player_id)
    end

    it "answers 409 match_in_progress for a lobby that never started" do
      match = create(:match)
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0, host: true)
      token = player.issue_session!(ip: "127.0.0.1").token

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, token

      expect(response).to have_http_status(:conflict)
      expect(json_body.dig("error", "code")).to eq("match_in_progress")
    end

    it "refuses a second forfeit on a match that is already over" do
      match, _host, _guest, host_token = running_match
      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token
      expect(response).to have_http_status(:ok)

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      expect(response).to have_http_status(:conflict)
      expect(await_ended(match.id).size).to eq(1)
    end

    it "ends a two-team match across teams, not by seat order" do
      match, host, guest, host_token = running_match(mode: "team")

      post_json "/api/v1/matches/#{match.id}/forfeit", {}, host_token

      expect(response).to have_http_status(:ok)
      expect(match.reload.winner_player_id).to eq(guest.id)
      expect(match.match_players.find_by(player_id: host.id).result).to eq("loss")
    end
  end

  describe "the leaderboard after a real result" do
    it "moves for both players, so the endpoint stops serving the seeded numbers" do
      _host, host_token = new_player
      match_id, _host_token, guest, guest_token = waiting_room(host_token)
      [host_token, guest_token].each { |token| post_json("/api/v1/matches/#{match_id}/ready", { ready: true }, token) }
      post_json "/api/v1/matches/#{match_id}/start", {}, host_token
      expect(response).to have_http_status(:ok)

      post_json "/api/v1/matches/#{match_id}/forfeit", {}, host_token
      expect(response).to have_http_status(:ok)

      get "/api/v1/leaderboard"
      expect(response).to have_http_status(:ok)
      entries = json_body["entries"].to_h { |entry| [entry["player_id"], entry] }

      expect(entries[guest.id]["wins"]).to eq(1)
      expect(entries[guest.id]["rating"]).to be > 1200
      expect(entries[_host.id]["losses"]).to eq(1)
      expect(entries[_host.id]["rating"]).to be < 1200
    end

    it "counts a result once, however many times it is applied" do
      match, host, guest, = running_match
      # Both forfeit paths converge on the runner, which applies a result once;
      # re-applying the same rows must not move the entry a second time.
      seat = match.match_players.find_by(player_id: guest.id)
      seat.update!(result: :win)
      entry = LeaderboardEntry.for(guest, mode: match.mode)
      entry.save!

      seat.update!(result: :win)

      expect(entry.reload.wins).to eq(1)
    end
  end
end
