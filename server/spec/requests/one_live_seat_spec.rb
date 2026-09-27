# frozen_string_literal: true

require "rails_helper"

# A player must never hold two live seats. With one seat in a lobby and another
# in a running match, `Starc::LobbyRegistry#current_seat` answers with whichever
# seat it finds first, so the client's `you.match_id` names a match that is not
# the one running and the browser renders a room it can never enter the game
# from. The REST join path refuses the second seat, and it leaves the door open
# again once the player leaves their lobby seat.
RSpec.describe "one live seat per player (REST)", type: :request do
  def register(prefix)
    name, token, = register_player(name: "#{prefix}#{SecureRandom.hex(3)}")
    [Player.find_by!(name: name), token]
  end

  def post_json(path, payload, token)
    post path, params: payload.to_json,
         headers: { "CONTENT_TYPE" => "application/json" }.merge(auth_headers(token))
  end

  def create_match(token, payload = {})
    post_json "/api/v1/matches", payload, token
    expect(response).to have_http_status(:created)
    json_body["match"]
  end

  def join_as(token, match_id)
    post_json "/api/v1/matches/#{match_id}/join", {}, token
  end

  def error_code
    json_body.dig("error", "code")
  end

  it "answers 409 already_in_match for a second live match and adds no seat" do
    _host, host_token = register("host")
    first = create_match(host_token)
    joiner, joiner_token = register("joiner")
    join_as(joiner_token, first["id"])
    expect(response).to have_http_status(:ok)
    _other, other_token = register("other")
    second = create_match(other_token)
    before = MatchPlayer.where(player_id: joiner.id).count

    expect { join_as(joiner_token, second["id"]) }.not_to change(MatchPlayer, :count)

    expect(response).to have_http_status(:conflict)
    expect(error_code).to eq("already_in_match")
    expect(json_body.dig("error", "message")).to include(first["id"].to_s)
    expect(Match.find(second["id"]).player_count).to eq(1)
    expect(MatchPlayer.where(player_id: joiner.id).count).to eq(before)
  end

  it "refuses a second seat even when the first live match is running" do
    player, token = register("runner")
    running = create(:match, :in_progress)
    create(:match_player, match: running, player: player, slot: 0, race: "terran")
    _other, other_token = register("other")
    lobby = create_match(other_token)

    expect { join_as(token, lobby["id"]) }.not_to change(MatchPlayer, :count)

    expect(response).to have_http_status(:conflict)
    expect(error_code).to eq("already_in_match")
    expect(Match.find(lobby["id"]).player_count).to eq(1)
  end

  it "still refuses a re-join into the same match the way it always has" do
    _host, host_token = register("host")
    match = create_match(host_token)

    expect { join_as(host_token, match["id"]) }.not_to change(MatchPlayer, :count)

    expect(response).to have_http_status(:conflict)
    expect(error_code).to eq("already_in_match")
    expect(Match.find(match["id"]).player_count).to eq(1)
  end

  it "lets a player whose only seat is in a finished match join a new one" do
    player, token = register("done")
    over = create(:match, :finished)
    create(:match_player, match: over, player: player, slot: 0, race: "terran")
    _other, other_token = register("other")
    lobby = create_match(other_token)

    join_as(token, lobby["id"])

    expect(response).to have_http_status(:ok)
    expect(Match.find(lobby["id"]).player_count).to eq(2)
    expect(MatchPlayer.where(player_id: player.id).count).to eq(2)
    expect(MatchPlayer.live_seats_for(player.id).pluck(:match_id)).to eq([lobby["id"]])
  end

  it "lets a player whose only seat is in an abandoned match join a new one" do
    player, token = register("gone")
    dead = create(:match, status: :abandoned, ended_at: 1.hour.ago)
    create(:match_player, match: dead, player: player, slot: 0, race: "terran")
    _other, other_token = register("other")
    lobby = create_match(other_token)

    join_as(token, lobby["id"])

    expect(response).to have_http_status(:ok)
    expect(Match.find(lobby["id"]).player_count).to eq(2)
  end

  it "frees the player for a new match once they leave their lobby seat" do
    joiner, joiner_token = register("joiner")
    first = create_match(joiner_token)
    _other, other_token = register("other")
    second = create_match(other_token)

    post_json "/api/v1/matches/#{first['id']}/leave", {}, joiner_token
    expect(response).to have_http_status(:ok)
    expect(Match.find(first["id"]).player_count).to eq(0)

    join_as(joiner_token, second["id"])

    expect(response).to have_http_status(:ok)
    expect(Match.find(second["id"]).player_count).to eq(2)
    expect(MatchPlayer.live_seats_for(joiner.id).pluck(:match_id)).to eq([second["id"]])
  end
end
