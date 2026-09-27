# frozen_string_literal: true

require "rails_helper"

# The one definition of "live" that both join paths consult, so REST and cable
# cannot disagree about whether a second seat is possible.
RSpec.describe MatchPlayer do
  describe ".live_seats_for" do
    let(:player) { create(:player) }
    let(:other) { create(:player) }

    def seat_in(match, for_player = player)
      create(:match_player, match: match, player: for_player,
                           slot: match.match_players.count, race: "terran")
    end

    it "counts a seat in a lobby" do
      seat = seat_in(create(:match, :lobby))

      expect(described_class.live_seats_for(player.id).pluck(:id)).to eq([seat.id])
    end

    it "counts a seat in a running match" do
      seat = seat_in(create(:match, :in_progress))

      expect(described_class.live_seats_for(player.id).pluck(:id)).to eq([seat.id])
    end

    it "ignores a seat in a finished match" do
      seat_in(create(:match, :finished))

      expect(described_class.live_seats_for(player.id)).to be_empty
    end

    it "ignores a seat in an abandoned match" do
      seat_in(create(:match, status: :abandoned, ended_at: 1.hour.ago))

      expect(described_class.live_seats_for(player.id)).to be_empty
    end

    it "never returns another player's seats" do
      seat_in(create(:match, :lobby), other)

      expect(described_class.live_seats_for(player.id)).to be_empty
    end

    it "returns both live seats of a player wrongly holding two" do
      seat_in(create(:match, :lobby))
      seat_in(create(:match, :in_progress))

      expect(described_class.live_seats_for(player.id).count).to eq(2)
    end
  end
end
