# frozen_string_literal: true

module Starc
  # Memoized loader for `shared/data/maps.json`.
  module Maps
    class MalformedError < StandardError; end

    class << self
      # Array of frozen map definition hashes, in file order.
      def all
        data
      end

      def find(id)
        index[id.to_s]
      end

      def ids
        @ids ||= data.map { |m| m["id"] }.freeze
      end

      def default_map_id
        ids.first
      end

      def exist?(id)
        !find(id).nil?
      end

      def data
        @data ||= load!
      end

      def reload!
        @data = nil
        @index = nil
        @ids = nil
        data
      end

      private

      def index
        @index ||= begin
          h = {}
          data.each { |m| h[m["id"].to_s] = m }
          h.freeze
        end
      end

      def load!
        path = Rails.root.join("..", "shared", "data", "maps.json")
        raise MalformedError, "map data not found at #{path}" unless File.exist?(path)

        parsed = JSON.parse(File.read(path))
        list = parsed.is_a?(Hash) ? parsed["maps"] : parsed
        raise MalformedError, "map data missing a maps array" unless list.is_a?(Array) && list.any?

        list.each do |m|
          raise MalformedError, "map entry is not an object" unless m.is_a?(Hash)
          raise MalformedError, "map entry missing id" unless m["id"]
        end

        deep_freeze(list)
      rescue JSON::ParserError => e
        raise MalformedError, "map data is not valid JSON: #{e.message}"
      end

      def deep_freeze(obj)
        case obj
        when Hash
          obj.each { |k, v| deep_freeze(v) }
          obj.freeze
        when Array
          obj.each { |v| deep_freeze(v) }
          obj.freeze
        else
          obj.freeze
        end
      end
    end
  end
end
