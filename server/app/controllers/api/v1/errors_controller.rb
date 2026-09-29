# frozen_string_literal: true

module Api
  module V1
    # Answers the paths that are not endpoints at all.
    #
    # A request to `/api/v1/nope` matches no route, so it never reaches a
    # controller: Rails falls through to `ActionDispatch::PublicExceptions`,
    # which in production returns an EMPTY body with `Content-Type:
    # text/html` (there is no `public/404.html` to render). Every real endpoint
    # already answers the documented `{ "error": { code, message } }` envelope
    # via `BaseController#render_error`, so a client only had to learn two
    # different failure shapes for the same class of problem — and the HTML one
    # is the worse of the two, because `res.json()` on an empty body throws a
    # parse error rather than surfacing the 404.
    #
    # This closes that gap. It subclasses `BaseController` for `render_error`
    # and nothing else: it deliberately does NOT call `require_auth!`, because
    # "that path does not exist" is the true answer whether or not the caller
    # presented a token, and answering 401 first would hide it.
    #
    # Reached by the `match "*unmatched"` route in config/routes.rb, which is
    # constrained to paths under `/api` so it cannot shadow the SPA fallback or
    # the health check.
    class ErrorsController < BaseController
      def not_found
        render_error("not_found", "No such endpoint: #{request.request_method} #{request.path}", :not_found)
      end
    end
  end
end
