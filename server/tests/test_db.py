from tournament_server.db import make_engine


def test_make_engine_enables_foreign_keys(tmp_path):
    db_path = str(tmp_path / "pragma_test.db")
    engine = make_engine(db_path)

    with engine.connect() as connection:
        result = connection.exec_driver_sql("PRAGMA foreign_keys").scalar()

    assert result == 1
