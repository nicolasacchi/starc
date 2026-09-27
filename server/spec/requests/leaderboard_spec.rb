# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Api::V1 leaderboard", type: :request do
  def entry_for(player, rating:, mode: "melee", race: "terran", wins: 0, losses: 0, draws: 0, rank: 0)
    create(:leaderboard_entry, player: player, rating: rating, mode: mode, race: race,
                              wins: wins, losses: losses, draws: draws, rank: rank)
  end

  describe "GET /api/v1/leaderboard" do
    it "is public and returns an empty list, not null, when nobody is ranked" do
      get "/api/v1/leaderboard"

      expect(response).to have_http_status(:ok)
      expect(json_body).to eq("entries" => [])
      expect(json_body["entries"]).to be_an(Array)
    end

    it "returns the full entry shape with the player's name attached" do
      player = create(:player, name: "topdog")
      entry_for(player, rating: 1500, wins: 8, losses: 2, draws: 1, race: "zerg")

      get "/api/v1/leaderboard"

      entry = json_body["entries"].first
      expect(entry.keys).to match_array(%w[rank player_id name race mode wins losses draws rating])
      expect(entry).to include("player_id" => player.id, "name" => "topdog", "race" => "zerg",
                               "mode" => "melee", "wins" => 8, "losses" => 2, "draws" => 1,
                               "rating" => 1500, "rank" => 1)
    end

    it "orders by rating descending and falls back to the listed position for an unranked row" do
      low = create(:player)
      high = create(:player)
      mid = create(:player)
      entry_for(low, rating: 1000)
      entry_for(high, rating: 1800)
      entry_for(mid, rating: 1400)

      get "/api/v1/leaderboard"

      expect(json_body["entries"].map { |e| e["rating"] }).to eq([1800, 1400, 1000])
      expect(json_body["entries"].map { |e| e["player_id"] }).to eq([high.id, mid.id, low.id])
      expect(json_body["entries"].map { |e| e["rank"] }).to eq([1, 2, 3])
    end

    it "breaks a rating tie on wins, then keeps the stored rank when one exists" do
      winner = create(:player)
      loser = create(:player)
      ranked = create(:player)
      entry_for(loser, rating: 1500, wins: 3)
      entry_for(winner, rating: 1500, wins: 9)
      entry_for(ranked, rating: 1500, wins: 9, rank: 7)

      get "/api/v1/leaderboard"

      expect(json_body["entries"].map { |e| e["player_id"] }).to eq([winner.id, ranked.id, loser.id])
      expect(json_body["entries"].map { |e| e["rank"] }).to eq([1, 7, 3])
    end

    it "filters by mode" do
      melee = create(:player)
      team = create(:player)
      entry_for(melee, rating: 1600, mode: "melee")
      entry_for(team, rating: 1500, mode: "team")

      get "/api/v1/leaderboard", params: { mode: "team" }

      expect(json_body["entries"].length).to eq(1)
      expect(json_body["entries"].first).to include("player_id" => team.id, "mode" => "team")

      get "/api/v1/leaderboard", params: { mode: "melee" }
      expect(json_body["entries"].map { |e| e["player_id"] }).to eq([melee.id])
    end

    it "filters by race" do
      zerg = create(:player)
      terran = create(:player)
      entry_for(zerg, rating: 1700, race: "zerg")
      entry_for(terran, rating: 1600, race: "terran")

      get "/api/v1/leaderboard", params: { race: "zerg" }

      expect(json_body["entries"].map { |e| e["player_id"] }).to eq([zerg.id])
    end

    it "combines the mode and race filters" do
      player = create(:player)
      entry_for(player, rating: 1700, mode: "1v1", race: "protoss")
      entry_for(player, rating: 1600, mode: "melee", race: "terran")

      get "/api/v1/leaderboard", params: { mode: "1v1", race: "protoss" }

      expect(json_body["entries"].length).to eq(1)
      expect(json_body["entries"].first).to include("mode" => "1v1", "race" => "protoss", "rating" => 1700)
    end

    it "ignores an unknown mode or race filter instead of emptying the board" do
      player = create(:player)
      entry_for(player, rating: 1500)

      get "/api/v1/leaderboard", params: { mode: "nonsense", race: "orc" }

      expect(json_body["entries"].length).to eq(1)
    end

    it "ranks each mode independently" do
      player = create(:player)
      entry_for(player, rating: 1300, mode: "melee")
      entry_for(player, rating: 1700, mode: "team")

      get "/api/v1/leaderboard"

      expect(json_body["entries"].map { |e| e["mode"] }).to eq(%w[team melee])
    end

    it "caps the limit at the server maximum instead of dumping the whole table" do
      players = Array.new(205) { create(:player) }
      players.each_with_index { |player, i| entry_for(player, rating: 1000 + i) }

      get "/api/v1/leaderboard", params: { limit: 200 }
      expect(json_body["entries"].length).to eq(200)
      expect(json_body["entries"].first["rating"]).to eq(1204)

      # Beyond the cap the server falls back to its default page, never 500.
      get "/api/v1/leaderboard", params: { limit: 100_000 }
      expect(response).to have_http_status(:ok)
      expect(json_body["entries"].length).to eq(50)
    end

    it "honours a limit inside the allowed range" do
      players = Array.new(6) { create(:player) }
      players.each_with_index { |player, i| entry_for(player, rating: 1000 + i) }

      get "/api/v1/leaderboard", params: { limit: 3 }

      expect(json_body["entries"].map { |e| e["rating"] }).to eq([1005, 1004, 1003])
    end

    it "falls back to the default page instead of erroring on limit 0, negative or non-numeric" do
      players = Array.new(60) { create(:player) }
      players.each_with_index { |player, i| entry_for(player, rating: 1000 + i) }

      [{ limit: 0 }, { limit: -7 }, { limit: "many" }, { limit: 1.5 }].each do |params|
        get "/api/v1/leaderboard", params: params

        expect(response).to have_http_status(:ok)
        expect(json_body["entries"].length).to eq(50)
      end
    end

    it "returns every entry when the table fits the default page" do
      players = Array.new(40) { create(:player) }
      players.each_with_index { |player, i| entry_for(player, rating: 1000 + i) }

      get "/api/v1/leaderboard"

      expect(json_body["entries"].length).to eq(40)
      expect(json_body["entries"].map { |e| e["rating"] }).to eq((1000..1039).to_a.reverse)
    end

    it "truncates a larger table to the default page rather than erroring" do
      players = Array.new(60) { create(:player) }
      players.each_with_index { |player, i| entry_for(player, rating: 1000 + i) }

      get "/api/v1/leaderboard"

      expect(response).to have_http_status(:ok)
      expect(json_body["entries"].length).to eq(50)
      expect(json_body["entries"].last["rating"]).to eq(1010)
    end
  end
end
