from __future__ import annotations

import datetime as dt

import jwt
import pytest
from fastapi import HTTPException

from tournament_server.auth import (
    ACCESS_TOKEN_LIFETIME_SECONDS,
    JWT_ALGORITHM,
    REFRESH_TOKEN_LIFETIME,
    ROLES,
    create_access_token,
    decrypt_password,
    encrypt_password,
    generate_refresh_token,
    get_password_encryption_key,
    get_signing_key,
    hash_password,
    hash_token,
    require_admin,
    require_any_role,
    require_role,
    require_scorer_or_referee,
    verify_password,
)
from tournament_server.db import init_db, make_engine, make_session_factory


def _db(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_roles_are_the_six_fixed_names():
    assert ROLES == (
        "admin",
        "scorer",
        "judge",
        "referee",
        "attendee",
        "display_device",
    )


def test_hash_password_round_trips():
    hashed = hash_password("correct horse")
    assert hashed != "correct horse"
    assert verify_password("correct horse", hashed)
    assert not verify_password("wrong password", hashed)


def test_hash_token_is_deterministic():
    assert hash_token("abc123") == hash_token("abc123")
    assert hash_token("abc123") != hash_token("xyz789")


def test_generate_refresh_token_is_unique_each_call():
    tokens = {generate_refresh_token() for _ in range(20)}
    assert len(tokens) == 20


def test_get_signing_key_persists_across_calls(tmp_path):
    db = _db(tmp_path)
    first = get_signing_key(db)
    second = get_signing_key(db)
    assert first == second
    assert len(first) >= 32


def test_get_password_encryption_key_persists_across_calls(tmp_path):
    db = _db(tmp_path)
    first = get_password_encryption_key(db)
    second = get_password_encryption_key(db)
    assert first == second


def test_password_encryption_key_is_independent_of_the_signing_key(tmp_path):
    db = _db(tmp_path)
    assert get_password_encryption_key(db) != get_signing_key(db).encode("utf-8")


def test_encrypt_and_decrypt_password_round_trips(tmp_path):
    db = _db(tmp_path)
    key = get_password_encryption_key(db)
    ciphertext = encrypt_password("correct horse", key)
    assert ciphertext != "correct horse"
    assert decrypt_password(ciphertext, key) == "correct horse"


def test_encrypt_password_is_not_decryptable_with_a_different_key(tmp_path):
    db = _db(tmp_path)
    key = get_password_encryption_key(db)
    ciphertext = encrypt_password("correct horse", key)

    other_dir = tmp_path / "other"
    other_dir.mkdir()
    other_db = _db(other_dir)
    other_key = get_password_encryption_key(other_db)

    with pytest.raises(Exception):
        decrypt_password(ciphertext, other_key)


def test_create_access_token_has_only_role_iat_exp_claims(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "scorer")
    payload = jwt.decode(token, get_signing_key(db), algorithms=[JWT_ALGORITHM])
    assert set(payload.keys()) == {"role", "iat", "exp"}
    assert payload["role"] == "scorer"
    assert payload["exp"] - payload["iat"] == ACCESS_TOKEN_LIFETIME_SECONDS


def test_require_role_401s_with_no_header(tmp_path):
    db = _db(tmp_path)
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=None, db=db)
    assert exc_info.value.status_code == 401


def test_require_role_401s_with_malformed_header(tmp_path):
    db = _db(tmp_path)
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization="not-a-bearer-token", db=db)
    assert exc_info.value.status_code == 401


def test_require_role_401s_on_expired_token(tmp_path):
    db = _db(tmp_path)
    signing_key = get_signing_key(db)
    now = dt.datetime.now(dt.UTC)
    expired = jwt.encode(
        {
            "role": "admin",
            "iat": int((now - dt.timedelta(hours=1)).timestamp()),
            "exp": int((now - dt.timedelta(minutes=1)).timestamp()),
        },
        signing_key,
        algorithm=JWT_ALGORITHM,
    )
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=f"Bearer {expired}", db=db)
    assert exc_info.value.status_code == 401


def test_require_role_401s_on_bad_signature(tmp_path):
    db = _db(tmp_path)
    get_signing_key(db)  # ensure a signing key row exists
    bogus = jwt.encode(
        {"role": "admin", "iat": 0, "exp": 9999999999}, "wrong-key", algorithm=JWT_ALGORITHM
    )
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=f"Bearer {bogus}", db=db)
    assert exc_info.value.status_code == 401


def test_require_role_403s_when_role_not_allowed(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "attendee")
    dependency = require_role("scorer", "referee")
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=f"Bearer {token}", db=db)
    assert exc_info.value.status_code == 403


def test_require_role_passes_when_role_allowed(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "scorer")
    dependency = require_role("scorer", "referee")
    assert dependency(authorization=f"Bearer {token}", db=db) == "scorer"


def test_admin_always_passes_regardless_of_allowed_roles(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "admin")
    dependency = require_role("scorer", "referee")
    assert dependency(authorization=f"Bearer {token}", db=db) == "admin"


def test_require_admin_rejects_non_admin(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "judge")
    with pytest.raises(HTTPException) as exc_info:
        require_admin(authorization=f"Bearer {token}", db=db)
    assert exc_info.value.status_code == 403


def test_require_any_role_accepts_every_role(tmp_path):
    db = _db(tmp_path)
    for role in ROLES:
        token = create_access_token(db, role)
        assert require_any_role(authorization=f"Bearer {token}", db=db) == role


def test_require_scorer_or_referee_rejects_judge(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "judge")
    with pytest.raises(HTTPException) as exc_info:
        require_scorer_or_referee(authorization=f"Bearer {token}", db=db)
    assert exc_info.value.status_code == 403


def test_refresh_token_lifetime_is_fourteen_days():
    assert REFRESH_TOKEN_LIFETIME == dt.timedelta(days=14)
