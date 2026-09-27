# frozen_string_literal: true

# Helpers shared by request and channel specs.
module ApiHelpers
  # Registers a player through the real endpoint so the token is issued by
  # the code under test, not fabricated.
  def register_player(name: nil, password: "hunter2")
    name ||= "player#{SecureRandom.hex(4)}"
    post "/api/v1/players", params: { name: name, password: password }.to_json,
         headers: { "CONTENT_TYPE" => "application/json" }
    body = JSON.parse(response.body)
    [name, body.fetch("token"), body.fetch("player")]
  end

  def auth_headers(token)
    { "Authorization" => "Bearer #{token}" }
  end

  def json_body
    JSON.parse(response.body)
  end
end

RSpec.configure { |config| config.include ApiHelpers, type: :request }
