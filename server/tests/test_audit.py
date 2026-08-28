import json

from tournament_server.audit import actor_scope, current_actor


def test_json_dumps_with_default_str_does_not_raise_on_bytes():
    # _write_audit_row serializes before/after with `default=str` as a
    # backstop for values `_to_jsonable` doesn't special-case (e.g. bytes,
    # Decimal). This directly exercises that serialization behavior.
    result = json.dumps({"x": b"raw-bytes"}, default=str)

    assert isinstance(result, str)
    assert json.loads(result)["x"] == str(b"raw-bytes")


def test_actor_scope_sets_and_restores_current_actor():
    assert current_actor.get() == "system"

    with actor_scope("robot-arm"):
        assert current_actor.get() == "robot-arm"

    assert current_actor.get() == "system"
