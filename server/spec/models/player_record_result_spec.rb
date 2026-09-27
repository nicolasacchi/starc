# frozen_string_literal: true

require "rails_helper"

# The end-of-match path can reach a player twice — a dev reload orphans a
# runner and a second one adopts the same match, and the two finalise
# independently — so `record_result!` has to survive being handed the same
# result by two callers that both read the row before either wrote it.
#
# Both examples below are the lost update, expressed without threads: the two
# `Player` instances are loaded before either write, which is exactly the state
# two runners' threads are in when they finalise at once.
RSpec.describe Player, "#record_result!" do
  let(:player) { create(:player, name: "nik") }

  it "counts both results when two of them are recorded from the same starting row" do
    first_call = Player.find(player.id)
    second_call = Player.find(player.id)

    first_call.record_result!(result: "win")
    second_call.record_result!(result: "win")

    expect(player.reload.wins).to eq(2)
  end

  it "counts both results across different outcomes too" do
    stale = Player.find(player.id)
    fresh = Player.find(player.id)

    fresh.record_result!(result: "win")
    stale.record_result!(result: "loss")

    expect(player.reload.wins).to eq(1)
    expect(player.reload.losses).to eq(1)
  end

  it "keeps the per-match stats of each result rather than one call's overwriting the other's" do
    first_call = Player.find(player.id)
    second_call = Player.find(player.id)

    first_call.record_result!(result: "win", kills: 4, deaths: 1)
    second_call.record_result!(result: "loss", kills: 2, deaths: 6)

    expect(player.reload.kills).to eq(2)
    expect(player.reload.deaths).to eq(6)
    expect(player.reload.wins).to eq(1)
    expect(player.reload.losses).to eq(1)
  end

  it "refuses an outcome it has no column for" do
    expect { player.record_result!(result: "walked away") }
      .to raise_error(ArgumentError, /unknown result/)
    expect(player.reload.wins).to eq(0)
  end
end
