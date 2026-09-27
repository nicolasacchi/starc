# frozen_string_literal: true

require "rails_helper"

# A finished match is the player's history: the seat row carries the result
# every summary, rating and replay reads. `remove_player!` destroys that row,
# so a `leave` that reached it erased a finished match from `recent_matches`
# without so much as an error — the guard only covered a *running* match.
#
# Leaving is how a lobby is emptied, so it still works there. What it must never
# do is destroy a result.
RSpec.describe "Leaving a match", type: :request do
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

  # A played match: the seats carry their results, as the runner writes them.
  def played_match(status: :finished, result: :loss)
    match = create(:match, mode: "melee", status: status,
                         started_at: 1.hour.ago, ended_at: 30.minutes.ago, duration_ms: 1_800_000,
                         end_reason: "annihilation", winner_player_id: nil)
    loser = create(:player)
    winner = create(:player)
    create(:match_player, match: match, player: loser, slot: 0, host: true, race: "terran", result: result)
    create(:match_player, match: match, player: winner, slot: 1, race: "zerg", result: result == :win ? :loss : :win)
    [match, loser, winner]
  end

  def recent_matches(player)
    player.match_players.joins(:match)
          .where(matches: { status: Match.statuses.values_at("finished", "abandoned") })
          .order("matches.id")
          .map { |seat| [seat.match_id, seat.result] }
  end

  describe "POST /api/v1/matches/:id/leave" do
    it "refuses a finished match and keeps the result in the player's history" do
      match, player, = played_match
      token = player.issue_session!(ip: "127.0.0.1").token
      before_history = recent_matches(player)

      post_json "/api/v1/matches/#{match.id}/leave", {}, token

      expect(response).to have_http_status(:conflict)
      expect(json_body.dig("error", "code")).to eq("match_finished")
      expect(recent_matches(player.reload)).to eq(before_history)
      expect(match.reload.match_players.count).to eq(2)
    end

    it "refuses an abandoned match as well" do
      match, player, = played_match(status: :abandoned)
      token = player.issue_session!(ip: "127.0.0.1").token
      before_history = recent_matches(player)

      post_json "/api/v1/matches/#{match.id}/leave", {}, token

      expect(response).to have_http_status(:conflict)
      expect(recent_matches(player.reload)).to eq(before_history)
    end

    it "still empties a lobby, which is what leaving is for" do
      player, token = new_player
      post_json "/api/v1/matches", { max_players: 2 }, token
      match_id = json_body.fetch("match").fetch("id")

      post_json "/api/v1/matches/#{match_id}/leave", {}, token

      expect(response).to have_http_status(:ok)
      expect(json_body["match"]).to include("status" => "abandoned", "player_count" => 0)
    end

    it "leaves a running match refused as before" do
      match = create(:match, :in_progress)
      player = create(:player)
      create(:match_player, match: match, player: player, slot: 0, host: true)
      token = player.issue_session!(ip: "127.0.0.1").token

      post_json "/api/v1/matches/#{match.id}/leave", {}, token

      expect(response).to have_http_status(:conflict)
      expect(json_body.dig("error", "code")).to eq("match_in_progress")
    end
  end
end
