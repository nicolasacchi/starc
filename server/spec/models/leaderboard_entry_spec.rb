# frozen_string_literal: true

require "rails_helper"

RSpec.describe LeaderboardEntry do
  def entry(player: create(:player), mode: "melee", rating: 1200, wins: 0)
    create(:leaderboard_entry, player: player, mode: mode, rating: rating, wins: wins)
  end

  describe ".for" do
    it "returns the existing row for the same player and mode instead of a second one" do
      player = create(:player)
      first = described_class.for(player, mode: "melee")
      first.save!

      second = described_class.for(player, mode: "melee")

      expect { second.save! }.not_to change(described_class, :count)
      expect(second.id).to eq(first.id)
      expect(described_class.where(player_id: player.id, mode: "melee").count).to eq(1)
    end

    it "keeps the modes of one player apart" do
      player = create(:player)
      melee = described_class.for(player, mode: "melee")
      melee.save!
      team = described_class.for(player, mode: "team")

      expect(team).to be_new_record
      expect(team.mode).to eq("team")
      expect(described_class.where(player_id: player.id).count).to eq(1)
    end

    it "accepts a bare player id as well as a Player" do
      player = create(:player)
      by_object = described_class.for(player, mode: "1v1")
      by_object.save!

      by_id = described_class.for(player.id, mode: "1v1")
      expect(by_id.id).to eq(by_object.id)
    end

    it "fills in a missing race but never overwrites one that is already recorded" do
      player = create(:player)
      fresh = described_class.for(player, mode: "melee", race: "zerg")
      fresh.save!
      expect(fresh.reload.race).to eq("zerg")

      again = described_class.for(player, mode: "melee", race: "protoss")
      expect(again.race).to eq("zerg")
    end

    it "leaves the race blank when none is asked for" do
      row = described_class.for(create(:player), mode: "melee")
      expect(row.race).to be_blank
    end
  end

  describe "validations" do
    it "only accepts the protocol modes" do
      expect(build(:leaderboard_entry, mode: "battle_royale")).not_to be_valid
      Match::MODES.each { |mode| expect(build(:leaderboard_entry, mode: mode)).to be_valid }
    end

    it "allows at most one entry per player per mode" do
      player = create(:player)
      create(:leaderboard_entry, player: player, mode: "melee")
      clash = build(:leaderboard_entry, player: player, mode: "melee")

      expect(clash).not_to be_valid
      expect(clash.errors[:player_id]).to include("already has an entry for this mode")
    end

    it "rejects a race outside the shared roster" do
      expect(build(:leaderboard_entry, race: "orc")).not_to be_valid
    end

    it "accepts a blank race but not a negative rating" do
      expect(build(:leaderboard_entry, race: "")).to be_valid
      expect(build(:leaderboard_entry, rating: -1)).not_to be_valid
    end
  end

  describe "#record!" do
    it "raises the rating and counts a win" do
      row = entry(rating: 1200)
      row.record!(result: "win", opponent_rating: 1200)

      row.reload
      expect(row.wins).to eq(1)
      expect(row.losses).to eq(0)
      expect(row.draws).to eq(0)
      expect(row.rating).to be > 1200
    end

    it "lowers the rating and counts a loss" do
      row = entry(rating: 1200)
      row.record!(result: "loss", opponent_rating: 1200)

      row.reload
      expect(row.losses).to eq(1)
      expect(row.wins).to eq(0)
      expect(row.rating).to be < 1200
    end

    it "leaves the rating alone for a draw against an equal opponent but counts the game" do
      row = entry(rating: 1200)
      row.record!(result: "draw", opponent_rating: 1200)

      row.reload
      expect(row.draws).to eq(1)
      expect(row.rating).to eq(1200)
    end

    it "moves the rating less for a win against a much weaker opponent than against an equal one" do
      against_equal = entry(rating: 1200)
      against_weak = entry(rating: 1200)

      against_equal.record!(result: "win", opponent_rating: 1200)
      against_weak.record!(result: "win", opponent_rating: 800)

      equal_delta = against_equal.reload.rating - 1200
      weak_delta = against_weak.reload.rating - 1200

      expect(equal_delta).to be_positive
      expect(weak_delta).to be_positive
      expect(weak_delta).to be < equal_delta
    end

    it "charges a loss against a much weaker opponent more than against an equal one" do
      against_equal = entry(rating: 1200)
      against_weak = entry(rating: 1200)

      against_equal.record!(result: "loss", opponent_rating: 1200)
      against_weak.record!(result: "loss", opponent_rating: 800)

      equal_cost = 1200 - against_equal.reload.rating
      weak_cost = 1200 - against_weak.reload.rating

      expect(equal_cost).to be_positive
      expect(weak_cost).to be > equal_cost
    end

    it "ranks an equal opponent as a coin flip" do
      expect(entry(rating: 1200).expected_score(1200)).to be_within(1e-9).of(0.5)
    end

    it "expects more of a win against a weaker opponent and less against a stronger one" do
      row = entry(rating: 1500)
      expect(row.expected_score(1000)).to be > row.expected_score(1500)
      expect(row.expected_score(2000)).to be < row.expected_score(1500)
    end

    it "never lets the rating fall below zero" do
      row = entry(rating: 5)
      3.times { row.record!(result: "loss", opponent_rating: 0) }

      expect(row.reload.rating).to eq(0)
      expect(row).to be_valid
    end

    it "never lets the rating run past the ceiling" do
      row = entry(rating: 3_990)
      3.times { row.record!(result: "win", opponent_rating: 4_000) }

      expect(row.reload.rating).to eq(4_000)
    end

    it "records the race when one is supplied" do
      row = described_class.for(create(:player), mode: "team")
      row.save!
      row.record!(result: "win", opponent_rating: 1200, race: "zerg")
      expect(row.reload.race).to eq("zerg")
    end

    it "raises on an unknown result and persists nothing" do
      row = entry(rating: 1200)
      expect { row.record!(result: "surrender") }.to raise_error(ArgumentError, /unknown result/)

      row.reload
      expect([row.wins, row.losses, row.draws, row.rating]).to eq([0, 0, 0, 1200])
    end
  end

  describe "#games" do
    it "counts every recorded outcome" do
      row = entry(wins: 3)
      row.update!(losses: 2, draws: 1)
      expect(row.games).to eq(6)
    end
  end

  describe "#recompute_rank!" do
    it "numbers the mode 1..n by rating, then wins, then id" do
      low = entry(rating: 1_100, wins: 1)
      top = entry(rating: 1_300, wins: 1)
      mid = entry(rating: 1_200, wins: 4)

      top.recompute_rank!

      expect(top.reload.rank).to eq(1)
      expect(mid.reload.rank).to eq(2)
      expect(low.reload.rank).to eq(3)
    end

    it "breaks a rating tie on wins" do
      few_wins = entry(rating: 1_200, wins: 1)
      many_wins = entry(rating: 1_200, wins: 9)
      many_wins.recompute_rank!

      expect(many_wins.reload.rank).to eq(1)
      expect(few_wins.reload.rank).to eq(2)
    end

    it "breaks a full tie on id so the order is deterministic" do
      first = entry(rating: 1_200, wins: 3)
      second = entry(rating: 1_200, wins: 3)
      third = entry(rating: 1_200, wins: 3)

      third.recompute_rank!

      expect([first.reload.rank, second.reload.rank, third.reload.rank]).to eq([1, 2, 3])
    end

    it "rewrites every row of the mode from any instance, and leaves other modes alone" do
      melee_high = entry(mode: "melee", rating: 1_400)
      melee_low = entry(mode: "melee", rating: 1_000)
      team_entry = entry(mode: "team", rating: 1_500)

      melee_low.recompute_rank!

      expect(melee_high.reload.rank).to eq(1)
      expect(melee_low.rank).to eq(2)
      expect(team_entry.reload.rank).to eq(0)
    end
  end

  describe ".recompute_ranks!" do
    it "renumbers only the requested mode" do
      entry(mode: "melee", rating: 1_000)
      entry(mode: "melee", rating: 1_200)
      team_entry = entry(mode: "team", rating: 1_500)

      described_class.recompute_ranks!(mode: "melee")

      expect(described_class.where(mode: "melee").order(:rating).pluck(:rank)).to eq([2, 1])
      expect(team_entry.reload.rank).to eq(0)
    end

    it "renumbers every mode when no mode is given" do
      entry(mode: "melee", rating: 1_000)
      entry(mode: "team", rating: 1_500)

      described_class.recompute_ranks!

      expect(described_class.where(mode: "melee").pluck(:rank)).to eq([1])
      expect(described_class.where(mode: "team").pluck(:rank)).to eq([1])
    end

    it "does nothing when there is nothing to rank" do
      described_class.recompute_ranks!
      expect(described_class.count).to eq(0)
    end
  end

  describe "the by_rank scope" do
    it "returns the entries best-first once ranks exist" do
      low = entry(rating: 1_000)
      mid = entry(rating: 1_200)
      high = entry(rating: 1_500)
      high.recompute_rank!

      expect(described_class.by_rank.to_a).to eq([high, mid, low])
    end
  end

  describe "ActiveRecord#valid? is not shadowed" do
    it "keeps the inherited valid? so a validation context can still be passed" do
      expect(described_class.instance_method(:valid?).owner).not_to eq(described_class)

      row = build(:leaderboard_entry, player: create(:player))
      expect(row.valid?(:create)).to be(true)
      expect { row.save! }.to change(described_class, :count).by(1)
    end
  end
end
