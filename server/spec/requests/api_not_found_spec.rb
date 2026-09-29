# frozen_string_literal: true

require "rails_helper"

# A request to a path that is not an endpoint at all must still be answered in
# the API's own error envelope.
#
# This is a production-only failure that the rest of the suite cannot see: in
# the test environment Rails renders a debug 404 page, so a client would look
# fine locally. In production there is no `public/404.html`, so the same
# request falls through to `ActionDispatch::PublicExceptions` and comes back
# with an EMPTY body and `Content-Type: text/html`. The browser client reads
# every response as JSON, so it throws a parse error instead of surfacing the
# 404 — and the failure surfaces as "the game is broken" rather than as a
# missing route. This spec pins the envelope so a real endpoint and a missing
# one are the same shape of failure to the client.
RSpec.describe "Api::V1 unknown endpoints", type: :request do
  it "answers an unmatched api path with the documented JSON error envelope" do
    get "/api/v1/nope"

    expect(response).to have_http_status(:not_found)
    expect(response.media_type).to eq("application/json")
    body = JSON.parse(response.body)
    expect(body["error"]["code"]).to eq("not_found")
    expect(body["error"]["message"]).to be_a(String).and(be_present)
  end

  it "names the method and path, so a wrong URL is diagnosable from the response" do
    delete "/api/v1/typo"

    body = JSON.parse(response.body)
    expect(body["error"]["message"]).to include("DELETE").and(include("/api/v1/typo"))
  end

  it "does not demand a bearer token to report that a path does not exist" do
    # A real endpoint answers 401 without a token. This one must not: the true
    # answer to "that path does not exist" is 404 whether or not you are logged
    # in, and 401 first would hide a genuine routing bug behind an auth error.
    get "/api/v1/nope"

    expect(response).to have_http_status(:not_found)
    expect(JSON.parse(response.body)["error"]["code"]).not_to eq("unauthenticated")
  end

  it "still answers 422 on a real endpoint that validates its body" do
    # The guard on the previous example: without this, a fix that made every
    # unmatched path return 200 or 401 would pass the tests above.
    post "/api/v1/session"

    expect(response).to have_http_status(422)
    expect(JSON.parse(response.body)["error"]["code"]).to be_present
  end
end
