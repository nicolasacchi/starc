# frozen_string_literal: true

require "rails_helper"

# Replay download: the two routes that hand a finished match back to a client
# for deterministic replay (PROTOCOL.md §7 and §8).
RSpec.describe "Api::V1 replay", type: :request do
  def finished_match
    match = create(:match, :finished, map_id: "chokepoint", mode: "melee", winner_player_id: nil)
    winner = create(:player, name: "winner1")
    loser = create(:player, name: "loser1")
    create(:match_player, match: match, player: winner, slot: 0, host: true, race: "terran",
                          team: 1, result: :win, kills: 12, deaths: 3)
    create(:match_player, match: match, player: loser, slot: 1, race: "zerg", team: 1,
                          result: :loss, kills: 2, deaths: 14)
    match.update!(winner_player_id: winner.id)
    [match, winner, loser]
  end

  def record_replay(match, commands: [{ "tick" => 0, "player_id" => 1, "c" => "move",
                                        "ids" => [101], "x" => 40.5, "y" => 12.25 }],
                    tick_count: 120)
    Replay.record!(match: match, commands: commands,
                   final_state: { "entities" => [{ "id" => 101, "kind" => "unit", "x" => 40.5, "y" => 12.25 }] },
                   tick_count: tick_count)
  end

  describe "GET /api/v1/matches/:id/replay" do
    it "is public" do
      match, = finished_match
      record_replay(match)

      get "/api/v1/matches/#{match.id}/replay"

      expect(response).to have_http_status(:ok)
    end

    it "answers 404 not_found when the match has no replay" do
      match, = finished_match

      get "/api/v1/matches/#{match.id}/replay"

      expect(response).to have_http_status(:not_found)
      expect(json_body.dig("error", "code")).to eq("not_found")
    end

    it "answers 404 not_found for an unknown or non-numeric match id" do
      ["/api/v1/matches/987654/replay", "/api/v1/matches/not-a-number/replay"].each do |path|
        get path

        expect(response).to have_http_status(:not_found)
        expect(json_body.dig("error", "code")).to eq("not_found")
      end
    end

    it "returns the PROTOCOL §7 download shape" do
      match, winner, = finished_match
      record_replay(match, tick_count: 120)

      get "/api/v1/matches/#{match.id}/replay"

      body = json_body
      expect(body.keys).to match_array(%w[header commands snapshots_meta replay_url final_state])
      expect(body["replay_url"]).to eq("/api/v1/matches/#{match.id}/replay")
      expect(body["snapshots_meta"]).to eq("tick_count" => 120, "command_count" => 1, "version" => 1)
      expect(body["commands"].first).to include("tick" => 0, "c" => "move", "ids" => [101],
                                               "x" => 40.5, "y" => 12.25)
      expect(body["final_state"]["entities"].first).to include("id" => 101, "kind" => "unit")
    end

    it "describes the header from the match itself, seed and seats included" do
      match, winner, loser = finished_match
      record_replay(match)

      get "/api/v1/matches/#{match.id}/replay"

      header = json_body["header"]
      expect(header).to include("match_id" => match.id, "map_id" => "chokepoint",
                                "seed" => match.seed, "mode" => "melee",
                                "duration_ms" => match.duration_ms, "winner" => winner.id)
      expect(header["started_at"]).to be_present
      expect(header["players"].map { |p| p["player_id"] }).to eq([winner.id, loser.id])
      expect(header["players"].map { |p| p["result"] }).to eq(%w[win loss])
      expect(header["players"].map { |p| p["name"] }).to eq([winner.name, loser.name])
    end

    it "counts the commands it actually stores" do
      match, = finished_match
      record_replay(match, commands: Array.new(4) { |i| { "tick" => i, "c" => "stop", "ids" => [i] } })

      get "/api/v1/matches/#{match.id}/replay"

      expect(json_body["snapshots_meta"]["command_count"]).to eq(4)
      expect(json_body["commands"].length).to eq(4)
    end

    it "keeps a second download byte-identical" do
      match, = finished_match
      record_replay(match)

      get "/api/v1/matches/#{match.id}/replay"
      first = response.body
      get "/api/v1/matches/#{match.id}/replay"

      expect(response.body).to eq(first)
    end
  end

  describe "GET /api/v1/matches/:id/replay_file" do
    it "is public" do
      match, = finished_match
      record_replay(match)

      get "/api/v1/matches/#{match.id}/replay_file"

      expect(response).to have_http_status(:ok)
    end

    it "sends the full PROTOCOL §8 replay as an attachment" do
      match, = finished_match
      record_replay(match)

      get "/api/v1/matches/#{match.id}/replay_file"

      expect(response).to have_http_status(:ok)
      expect(response.media_type).to eq("application/json")
      disposition = response.headers["Content-Disposition"]
      expect(disposition).to include("attachment")
      expect(disposition).to include("starc-match-#{match.id}-replay.json")
    end

    it "carries the format, header, commands and final state the simulator replays from" do
      match, winner, = finished_match
      record_replay(match, tick_count: 120)

      get "/api/v1/matches/#{match.id}/replay_file"

      body = JSON.parse(response.body)
      expect(body.keys).to match_array(%w[format version header commands final_state])
      expect(body["format"]).to eq("starc-replay")
      expect(body["version"]).to eq(1)
      expect(body["header"]).to include("match_id" => match.id, "seed" => match.seed,
                                        "winner" => winner.id)
      expect(body["commands"].length).to eq(1)
      expect(body["final_state"]["entities"].first["id"]).to eq(101)
    end

    it "answers 404 not_found when the match has no replay" do
      match, = finished_match

      get "/api/v1/matches/#{match.id}/replay_file"

      expect(response).to have_http_status(:not_found)
      expect(json_body.dig("error", "code")).to eq("not_found")
    end

    it "answers 404 not_found for an unknown match id" do
      get "/api/v1/matches/424242/replay_file"

      expect(response).to have_http_status(:not_found)
      expect(json_body.dig("error", "code")).to eq("not_found")
    end
  end
end
