// CREATE TABLE satcatdata (
//     object_name character varying(255),
//     object_id character varying(255),
//     norad_cat_id integer NOT NULL,
//     object_type character varying(10),
//     ops_status_code character varying(10),
//     owner character varying(255),
//     launch_date date,
//     launch_site character varying(255),
//     decay_date date,
//     period real,
//     inclination real,
//     apogee real,
//     perigee real,
//     rcs real,
//     data_status_code character varying(10),
//     orbit_center character varying(50),
//     docked_norad_cat_id integer,
//     orbit_type character varying(10)
// );

export type satcatRow = {
    object_name: string;
    object_id: string;
    norad_cat_id: number;
    object_type: string;
    ops_status_code: string;
    owner: string;
    launch_date: string;
    launch_site: string;
    decay_date: string;
    period: number;
    inclination: number;
    apogee: number;
    perigee: number;
    rcs: number;
    data_status_code: string;
    orbit_center: string;
    docked_norad_cat_id: number;
    orbit_type: string;
};